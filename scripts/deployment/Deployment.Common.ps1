#requires -Version 7.4

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:CanonicalRepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
$script:CanonicalHealthUri = "http://127.0.0.1:8790/api/ready"
$script:CanonicalLivenessUri = "http://127.0.0.1:8790/api/health"
$script:CanonicalReadyUri = $script:CanonicalHealthUri
$script:CanonicalTaskName = "UnifiedAIOrchestrator-Local"
$script:CanonicalRunnerTaskName = "UnifiedAIOrchestrator-GitHubRunner"
$script:CanonicalRunnerRepositoryUrl = "https://github.com/yashumani/unified-ai-orchestrator"
$script:PinnedRunnerVersion = "2.337.0"
$script:PinnedRunnerArchiveSha256 = "1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc"
$script:PinnedRunnerArchiveUrl = "https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip"
$script:ShaPattern = "^[0-9a-f]{40}$"

function Assert-CanonicalRepositoryRoot {
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $resolved = [System.IO.Path]::GetFullPath($RepositoryRoot)
  if (-not [string]::Equals(
      $resolved.TrimEnd("\"),
      $script:CanonicalRepositoryRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "RepositoryRoot must be the canonical repository path $script:CanonicalRepositoryRoot."
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "Canonical repository root does not exist: $resolved"
  }
  return $script:CanonicalRepositoryRoot
}

function Assert-CommitSha {
  param([Parameter(Mandatory)][string]$CommitSha)

  if ($CommitSha -cnotmatch $script:ShaPattern) {
    throw "Commit SHA must be exactly 40 lowercase hexadecimal characters."
  }
  return $CommitSha
}

function Assert-CanonicalTaskName {
  param([Parameter(Mandatory)][string]$TaskName)

  if ($TaskName -cne $script:CanonicalTaskName) {
    throw "TaskName is pinned to $script:CanonicalTaskName."
  }
  return $TaskName
}

function Assert-CanonicalRunnerTaskName {
  param([Parameter(Mandatory)][string]$TaskName)

  if ($TaskName -cne $script:CanonicalRunnerTaskName) {
    throw "Runner TaskName is pinned to $script:CanonicalRunnerTaskName."
  }
  return $TaskName
}

function Assert-CanonicalHealthUri {
  param([Parameter(Mandatory)][string]$HealthUri)

  if ($HealthUri -cne $script:CanonicalHealthUri) {
    throw "HealthUri is pinned to the loopback endpoint $script:CanonicalHealthUri."
  }
  return $HealthUri
}

function Enter-DeploymentMutex {
  param([int]$TimeoutSeconds = 15)

  $mutex = [System.Threading.Mutex]::new($false, "Global\UnifiedAIOrchestratorDeploymentState")
  if (-not $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))) {
    $mutex.Dispose()
    throw "Another local deployment operation holds the deployment-state lock."
  }
  return $mutex
}

function Enter-DeploymentTransactionMutex {
  param([int]$TimeoutSeconds = 15)

  $mutex = [System.Threading.Mutex]::new($false, "Global\UnifiedAIOrchestratorDeploymentTransaction")
  if (-not $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))) {
    $mutex.Dispose()
    throw "Another deploy or rollback operation is already running."
  }
  return $mutex
}

function Exit-DeploymentMutex {
  param([System.Threading.Mutex]$Mutex)

  if ($null -ne $Mutex) {
    try {
      $Mutex.ReleaseMutex()
    } finally {
      $Mutex.Dispose()
    }
  }
}

function Get-DeploymentLayout {
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $root = Join-Path $RepositoryRoot ".local\deployment"
  return [ordered]@{
    Root = $root
    Releases = Join-Path $root "releases"
    Staging = Join-Path $root "staging"
    State = Join-Path $root "state"
    Backups = Join-Path $root "backups"
    Logs = Join-Path $root "logs"
    Downloads = Join-Path $root "downloads"
    RunnerRoot = Join-Path $root "github-runner\2.337.0"
    Current = Join-Path $root "current.json"
    Previous = Join-Path $root "previous.json"
    Pending = Join-Path $root "pending.json"
    Process = Join-Path $root "state\process.json"
    RunnerInstallation = Join-Path $root "state\github-runner-installation.json"
    RunnerProcess = Join-Path $root "state\github-runner-process.json"
    Events = Join-Path $root "logs\deployment-events.jsonl"
  }
}

function Assert-ContainedPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path,
    [switch]$AllowRoot
  )

  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
  $pathFull = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $equals = [string]::Equals(
    $rootFull,
    $pathFull,
    [System.StringComparison]::OrdinalIgnoreCase
  )
  $contained = $pathFull.StartsWith(
    "$rootFull\",
    [System.StringComparison]::OrdinalIgnoreCase
  )
  if ((-not $contained) -and (-not ($AllowRoot -and $equals))) {
    throw "Unsafe path outside deployment root: $pathFull"
  }
  $current = $rootFull
  if (Test-Path -LiteralPath $current) {
    $rootItem = Get-Item -LiteralPath $current -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Contained path root must not be a reparse point: $current"
    }
  }
  if (-not $equals) {
    $relative = [System.IO.Path]::GetRelativePath($rootFull, $pathFull)
    foreach ($segment in $relative.Split("\")) {
      $current = Join-Path $current $segment
      if (-not (Test-Path -LiteralPath $current)) {
        break
      }
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Contained path cannot traverse a reparse point: $current"
      }
    }
  }
  return $pathFull
}

function Assert-NoDeploymentReparsePoints {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $repository = Get-Item -LiteralPath $script:CanonicalRepositoryRoot -Force
  if (($repository.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Canonical repository root must not be a reparse point."
  }

  foreach ($path in @(
      (Join-Path $script:CanonicalRepositoryRoot ".local"),
      $Layout.Root,
      $Layout.Releases,
      $Layout.Staging,
      $Layout.State,
      $Layout.Backups,
      $Layout.Logs,
      $Layout.Downloads,
      (Split-Path -Parent $Layout.RunnerRoot),
      $Layout.RunnerRoot
    )) {
    if (Test-Path -LiteralPath $path) {
      $item = Get-Item -LiteralPath $path -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Deployment path must not be a reparse point: $path"
      }
    }
  }
}

function Initialize-DeploymentLayout {
  param([Parameter(Mandatory)][hashtable]$Layout)

  foreach ($path in @(
      $Layout.Root,
      $Layout.Releases,
      $Layout.Staging,
      $Layout.State,
      $Layout.Backups,
      $Layout.Logs,
      $Layout.Downloads,
      (Split-Path -Parent $Layout.RunnerRoot)
    )) {
    [void](Assert-ContainedPath -Root $Layout.Root -Path $path -AllowRoot)
    [void](New-Item -ItemType Directory -Path $path -Force)
  }
  Assert-NoDeploymentReparsePoints -Layout $Layout
}

function Invoke-GitText {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string[]]$Arguments
  )

  $output = & git.exe -C $RepositoryRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return (($output -join "`n").Trim())
}

function Assert-DeploymentSource {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  [void](Assert-CommitSha -CommitSha $ExpectedSha)
  $head = Invoke-GitText -RepositoryRoot $RepositoryRoot -Arguments @("rev-parse", "HEAD")
  if ($head -cne $ExpectedSha) {
    throw "Canonical repository HEAD $head does not match expected deployment SHA $ExpectedSha."
  }
  $branch = Invoke-GitText -RepositoryRoot $RepositoryRoot -Arguments @("branch", "--show-current")
  if ($branch -cne "main") {
    throw "Local-production deployment is allowed only from branch main; current branch is $branch."
  }
  $status = Invoke-GitText -RepositoryRoot $RepositoryRoot -Arguments @(
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  )
  if ($status.Length -ne 0) {
    throw "Canonical repository must be clean before deployment."
  }
  return [ordered]@{ head = $head; branch = $branch; clean = $true }
}

function ConvertTo-JsonText {
  param([Parameter(Mandatory)][object]$Value)

  return ($Value | ConvertTo-Json -Depth 100)
}

function Write-AtomicJson {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][object]$Value
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Path)
  $parent = Split-Path -Parent $Path
  [void](New-Item -ItemType Directory -Path $parent -Force)
  $temporary = Join-Path $parent ".$([System.IO.Path]::GetFileName($Path)).$([guid]::NewGuid().ToString('N')).tmp"
  [void](Assert-ContainedPath -Root $Layout.Root -Path $temporary)
  try {
    [System.IO.File]::WriteAllText(
      $temporary,
      "$(ConvertTo-JsonText -Value $Value)`n",
      [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::Move($temporary, $Path, $true)
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Read-JsonHashtable {
  param([Parameter(Mandatory)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required JSON file does not exist: $Path"
  }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable -Depth 100)
  } catch {
    throw "Invalid JSON file $Path`: $($_.Exception.Message)"
  }
}

function Write-DeploymentEvent {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Action,
    [Parameter(Mandatory)][ValidateSet("started", "succeeded", "failed", "info")][string]$Status,
    [string]$CommitSha,
    [string]$OperationId,
    [string]$Message
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Layout.Events)
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Layout.Events) -Force)
  $event = [ordered]@{
    schemaVersion = 1
    occurredAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    action = $Action
    status = $Status
    commitSha = $CommitSha
    operationId = $OperationId
    message = if ($null -eq $Message) { "" } else { $Message.Substring(0, [Math]::Min(500, $Message.Length)) }
  }
  [System.IO.File]::AppendAllText(
    $Layout.Events,
    "$(ConvertTo-JsonText -Value $event)`n",
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Assert-SafePayloadPath {
  param(
    [Parameter(Mandatory)][string]$RelativePath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  if (
    $RelativePath.Length -eq 0 -or
    $RelativePath.Length -gt 240 -or
    $RelativePath.Contains("\") -or
    $RelativePath.StartsWith("/") -or
    $RelativePath.Contains([char]0)
  ) {
    throw "Unsafe release payload path: $RelativePath"
  }
  $segments = $RelativePath.Split("/")
  if ($segments | Where-Object { $_ -in @("", ".", "..") }) {
    throw "Unsafe release payload path: $RelativePath"
  }
  $lower = $RelativePath.ToLowerInvariant()
  if (
    $lower -eq ".env" -or
    $lower.StartsWith(".env.") -or
    $lower -eq ".git" -or
    $lower.StartsWith(".git/") -or
    $lower -eq ".local" -or
    $lower.StartsWith(".local/") -or
    $lower -eq "node_modules" -or
    $lower.StartsWith("node_modules/") -or
    $lower.StartsWith("data/raw/") -or
    $lower.StartsWith("sources/private/") -or
    $lower.StartsWith("sources/chatgpt/")
  ) {
    throw "Forbidden release payload path: $RelativePath"
  }
  $candidate = Join-Path $DestinationRoot ($RelativePath.Replace("/", "\"))
  return (Assert-ContainedPath -Root $DestinationRoot -Path $candidate)
}

function Assert-ReleaseManifest {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$Manifest,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  $requiredKeys = @(
    "schemaVersion",
    "commitSha",
    "createdAtUtc",
    "nodeVersion",
    "packageLockSha256",
    "payloadSha256"
  )
  $keys = @($Manifest.Keys)
  if (@($keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $keys }).Count -ne 0) {
    throw "release-manifest.json must contain only the six documented release fields."
  }
  if ([int]$Manifest.schemaVersion -ne 1) {
    throw "Unsupported release manifest schemaVersion."
  }
  [void](Assert-CommitSha -CommitSha ([string]$Manifest.commitSha))
  if ([string]$Manifest.commitSha -cne $ExpectedSha) {
    throw "Release manifest SHA does not match ExpectedSha."
  }
  $createdAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse(
      [string]$Manifest.createdAtUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$createdAt
    ) -or $createdAt.Offset -ne [TimeSpan]::Zero) {
    throw "Release manifest createdAtUtc must be a UTC timestamp."
  }
  if ([string]$Manifest.nodeVersion -notmatch "^v?\d+\.\d+\.\d+") {
    throw "Release manifest nodeVersion is invalid."
  }
  if ([string]$Manifest.packageLockSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Release manifest packageLockSha256 is invalid."
  }
  if ($Manifest.payloadSha256 -isnot [System.Collections.IDictionary]) {
    throw "Release manifest payloadSha256 must be an object."
  }
  if ($Manifest.payloadSha256.Count -lt 5 -or $Manifest.payloadSha256.Count -gt 10000) {
    throw "Release manifest payload file count is outside the allowed range."
  }
  foreach ($entry in $Manifest.payloadSha256.GetEnumerator()) {
    if ([string]$entry.Value -cnotmatch "^[0-9a-f]{64}$") {
      throw "Invalid SHA-256 for release payload path $($entry.Key)."
    }
  }
  foreach ($requiredPath in @(
      "package.json",
      "package-lock.json",
      "apps/api/package.json",
      "apps/api/dist/server.js",
      "apps/web/dist/index.html"
    )) {
    if (-not $Manifest.payloadSha256.Contains($requiredPath)) {
      throw "Release payload is missing required file $requiredPath."
    }
  }
  if ([string]$Manifest.payloadSha256["package-lock.json"] -cne [string]$Manifest.packageLockSha256) {
    throw "packageLockSha256 does not match the payload hash for package-lock.json."
  }
}

function Test-ReleaseArchive {
  param(
    [Parameter(Mandatory)][string]$ArtifactPath,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  $artifact = [System.IO.Path]::GetFullPath($ArtifactPath)
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Release artifact does not exist: $artifact"
  }
  if ([System.IO.Path]::GetExtension($artifact) -cne ".zip") {
    throw "Release artifact must be a .zip file."
  }

  $archive = [System.IO.Compression.ZipFile]::OpenRead($artifact)
  try {
    $entries = [System.Collections.Generic.Dictionary[string, System.IO.Compression.ZipArchiveEntry]]::new(
      [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($entry in $archive.Entries) {
      if ($entry.Name.Length -eq 0) {
        [void](Assert-SafePayloadPath -RelativePath $entry.FullName.TrimEnd("/") -DestinationRoot "C:\release-validation")
        continue
      }
      $safeName = $entry.FullName
      [void](Assert-SafePayloadPath -RelativePath $safeName -DestinationRoot "C:\release-validation")
      if (-not $entries.TryAdd($safeName, $entry)) {
        throw "Release archive contains a duplicate path: $safeName"
      }
    }
    if (-not $entries.ContainsKey("release-manifest.json")) {
      throw "Release archive is missing root release-manifest.json."
    }
    $manifestEntry = $entries["release-manifest.json"]
    $stream = $manifestEntry.Open()
    try {
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $true, 1024, $true)
      try {
        $manifest = $reader.ReadToEnd() | ConvertFrom-Json -AsHashtable -Depth 100
      } finally {
        $reader.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
    Assert-ReleaseManifest -Manifest $manifest -ExpectedSha $ExpectedSha

    $expectedEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    [void]$expectedEntries.Add("release-manifest.json")
    foreach ($payload in $manifest.payloadSha256.GetEnumerator()) {
      $path = [string]$payload.Key
      [void](Assert-SafePayloadPath -RelativePath $path -DestinationRoot "C:\release-validation")
      [void]$expectedEntries.Add($path)
      if (-not $entries.ContainsKey($path)) {
        throw "Release archive is missing manifest payload path $path."
      }
      $payloadStream = $entries[$path].Open()
      try {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
          $actual = [Convert]::ToHexString($hasher.ComputeHash($payloadStream)).ToLowerInvariant()
        } finally {
          $hasher.Dispose()
        }
      } finally {
        $payloadStream.Dispose()
      }
      if ($actual -cne [string]$payload.Value) {
        throw "Release archive hash mismatch for $path."
      }
    }
    foreach ($entryName in $entries.Keys) {
      if (-not $expectedEntries.Contains($entryName)) {
        throw "Release archive contains an undeclared file: $entryName"
      }
    }
    return $manifest
  } finally {
    $archive.Dispose()
  }
}

function Expand-ValidatedReleaseArchive {
  param(
    [Parameter(Mandatory)][string]$ArtifactPath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($ArtifactPath))
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.Name.Length -eq 0) {
        continue
      }
      $target = Assert-SafePayloadPath -RelativePath $entry.FullName -DestinationRoot $DestinationRoot
      $parent = Split-Path -Parent $target
      [void](New-Item -ItemType Directory -Path $parent -Force)
      $input = $entry.Open()
      try {
        $output = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
          $input.CopyTo($output)
        } finally {
          $output.Dispose()
        }
      } finally {
        $input.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Test-ReleaseDirectory {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $ReleaseRoot)
  $relativeRoot = [System.IO.Path]::GetRelativePath($Layout.Root, $ReleaseRoot).Replace("\", "/")
  if (-not ($relativeRoot.StartsWith("releases/") -or $relativeRoot.StartsWith("staging/"))) {
    throw "Release validation path must be under deployment releases or staging."
  }
  $manifestPath = Join-Path $ReleaseRoot "release-manifest.json"
  $manifest = Read-JsonHashtable -Path $manifestPath
  Assert-ReleaseManifest -Manifest $manifest -ExpectedSha $ExpectedSha
  foreach ($payload in $manifest.payloadSha256.GetEnumerator()) {
    $path = Assert-SafePayloadPath -RelativePath ([string]$payload.Key) -DestinationRoot $ReleaseRoot
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Installed release is missing payload path $($payload.Key)."
    }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne [string]$payload.Value) {
      throw "Installed release hash mismatch for $($payload.Key)."
    }
  }
  return $manifest
}

function Get-ReleaseRoot {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$CommitSha
  )

  [void](Assert-CommitSha -CommitSha $CommitSha)
  return (Assert-ContainedPath -Root $Layout.Releases -Path (Join-Path $Layout.Releases $CommitSha))
}

function New-ReleasePointer {
  param(
    [Parameter(Mandatory)][string]$CommitSha,
    [Parameter(Mandatory)][string]$Reason
  )

  return [ordered]@{
    schemaVersion = 1
    commitSha = $CommitSha
    activatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    reason = $Reason
  }
}

function Read-ReleasePointer {
  param([Parameter(Mandatory)][string]$Path)

  $pointer = Read-JsonHashtable -Path $Path
  $requiredKeys = @("schemaVersion", "commitSha", "activatedAtUtc", "reason")
  if (@($pointer.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $pointer.Keys }).Count -ne 0 -or
      [int]$pointer.schemaVersion -ne 1) {
    throw "Invalid release pointer: $Path"
  }
  [void](Assert-CommitSha -CommitSha ([string]$pointer.commitSha))
  return $pointer
}

function Backup-DeploymentState {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$OperationId
  )

  if ($OperationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$") {
    throw "Unsafe deployment operation id."
  }
  $backupRoot = Assert-ContainedPath -Root $Layout.Backups -Path (Join-Path $Layout.Backups $OperationId)
  [void](New-Item -ItemType Directory -Path $backupRoot)
  foreach ($statePath in @($Layout.Current, $Layout.Previous, $Layout.Pending, $Layout.Process)) {
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
      Copy-Item -LiteralPath $statePath -Destination (Join-Path $backupRoot ([System.IO.Path]::GetFileName($statePath)))
    }
  }
  Write-AtomicJson -Layout $Layout -Path (Join-Path $backupRoot "backup.json") -Value ([ordered]@{
      schemaVersion = 1
      operationId = $OperationId
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
      scope = "pointer-and-process-state-only"
    })
  return $backupRoot
}

function Get-OperationId {
  return "$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
}

function Get-StableExecutable {
  param([Parameter(Mandatory)][ValidateSet("node.exe", "npm.cmd", "pwsh.exe")][string]$Name)

  if ($Name -eq "pwsh.exe") {
    $stablePowerShell = "C:\Program Files\PowerShell\7\pwsh.exe"
    if (Test-Path -LiteralPath $stablePowerShell -PathType Leaf) {
      return $stablePowerShell
    }
  }
  $command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
  return $command.Source
}

function Assert-NodeRuntime {
  param([Parameter(Mandatory)][string]$NodePath)

  $version = (& $NodePath --version 2>&1 | Select-Object -First 1).ToString().Trim()
  if ($LASTEXITCODE -ne 0 -or $version -notmatch "^v(?<major>\d+)\.\d+\.\d+") {
    throw "Unable to verify the Node.js runtime."
  }
  if ([int]$Matches.major -lt 22) {
    throw "Node.js 22 or newer is required; found $version."
  }
  return $version
}

function Get-LiveReleaseProcess {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [string]$ExpectedSha
  )

  if (-not (Test-Path -LiteralPath $Layout.Process -PathType Leaf)) {
    return $null
  }
  $receipt = Read-JsonHashtable -Path $Layout.Process
  foreach ($key in @("schemaVersion", "commitSha", "pid", "entrypoint", "nodePath", "startedAtUtc", "stdoutPath", "stderrPath", "supervised")) {
    if (-not $receipt.Contains($key)) {
      throw "Process receipt is missing $key."
    }
  }
  if ([int]$receipt.schemaVersion -ne 1) {
    throw "Unsupported process receipt schemaVersion."
  }
  [void](Assert-CommitSha -CommitSha ([string]$receipt.commitSha))
  if ($ExpectedSha -and [string]$receipt.commitSha -cne $ExpectedSha) {
    throw "Live process receipt SHA does not match the selected release."
  }
  [void](Assert-ContainedPath -Root $Layout.Releases -Path ([string]$receipt.entrypoint))
  [void](Assert-ContainedPath -Root $Layout.Logs -Path ([string]$receipt.stdoutPath))
  [void](Assert-ContainedPath -Root $Layout.Logs -Path ([string]$receipt.stderrPath))
  $pidValue = [int]$receipt.pid
  if ($pidValue -lt 1) {
    throw "Process receipt PID is invalid."
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $null
  }
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$process.ExecutablePath),
      [System.IO.Path]::GetFullPath([string]$receipt.nodePath),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "PID $pidValue is not the recorded Node.js executable; refusing to manage it."
  }
  if ([string]$process.CommandLine -notlike "*$([string]$receipt.entrypoint)*") {
    throw "PID $pidValue command line does not contain the recorded release entrypoint."
  }
  return [ordered]@{ receipt = $receipt; process = $process }
}

function Wait-ForReleaseHealth {
  param(
    [Parameter(Mandatory)][string]$HealthUri,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [Parameter(Mandatory)][int]$TimeoutSeconds
  )

  [void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
  [void](Assert-CommitSha -CommitSha $ExpectedSha)
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 60) {
    throw "Health timeout must be from 1 to 60 seconds."
  }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = "health endpoint did not respond"
  do {
    try {
      $response = Invoke-RestMethod -Uri $script:CanonicalLivenessUri -Method Get -TimeoutSec 5 -Headers @{ Host = "127.0.0.1:8790" }
      if (
        [string]$response.status -eq "ok" -and
        [string]$response.app -eq "unified-ai-orchestrator" -and
        [string]$response.mode -eq "local" -and
        [string]$response.model -eq "qwen3:4b"
      ) {
        $readiness = Invoke-RestMethod -Uri $HealthUri -Method Get -TimeoutSec 5 -Headers @{ Host = "127.0.0.1:8790" }
        if (
          [string]$readiness.status -eq "ready" -and
          [string]$readiness.app -eq "unified-ai-orchestrator" -and
          [string]$readiness.mode -eq "local" -and
          [string]$readiness.releaseSha -ceq $ExpectedSha -and
          [string]$readiness.checks.evidence -eq "ready"
        ) {
          return [ordered]@{ health = $response; readiness = $readiness }
        }
        $lastError = "readiness response did not attest the selected release SHA"
      } else {
        $lastError = "health response did not match the pinned application contract"
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 750
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Release health check failed: $lastError"
}

function Assert-DeploymentTaskRegistration {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$TaskName
  )

  [void](Assert-CanonicalTaskName -TaskName $TaskName)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    throw "Scheduled task $TaskName is not installed. Run Install-LocalProductionTask.ps1 interactively first."
  }
  $expectedScript = Join-Path $RepositoryRoot "scripts\deployment\Start-LocalRelease.ps1"
  $actions = @($task.Actions)
  if ($actions.Count -ne 1) {
    throw "Scheduled task $TaskName has an unexpected action count."
  }
  $action = $actions[0]
  if (
    [string]$action.Execute -notlike "*pwsh.exe" -or
    [string]$action.Arguments -notlike "*`"$expectedScript`"*" -or
    [string]$action.Arguments -notlike "*-Supervised*"
  ) {
    throw "Scheduled task $TaskName does not match the repository-scoped supervised launcher."
  }
  return $task
}

function Read-GitHubRunnerInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.RunnerInstallation
  foreach ($key in @(
      "schemaVersion",
      "version",
      "archiveSha256",
      "repositoryUrl",
      "labels",
      "runnerName",
      "runnerRoot",
      "taskName",
      "powerShellPath",
      "configured",
      "installedAtUtc"
    )) {
    if (-not $state.Contains($key)) {
      throw "GitHub runner installation state is missing $key."
    }
  }
  if (
    [int]$state.schemaVersion -ne 1 -or
    [string]$state.version -cne $script:PinnedRunnerVersion -or
    [string]$state.archiveSha256 -cne $script:PinnedRunnerArchiveSha256 -or
    [string]$state.repositoryUrl -cne $script:CanonicalRunnerRepositoryUrl -or
    [string]$state.taskName -cne $script:CanonicalRunnerTaskName -or
    [string]$state.runnerRoot -cne $Layout.RunnerRoot -or
    @($state.labels).Count -ne 1 -or
    [string](@($state.labels)[0]) -cne "unified-ai-orchestrator"
  ) {
    throw "GitHub runner installation state does not match the pinned repository contract."
  }
  [void](Assert-ContainedPath -Root $Layout.Root -Path ([string]$state.runnerRoot))
  if (-not (Test-Path -LiteralPath ([string]$state.powerShellPath) -PathType Leaf)) {
    throw "The PowerShell executable recorded for the GitHub runner task is unavailable."
  }
  return $state
}

function Assert-GitHubRunnerTaskRegistration {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Installation
  )

  [void](Assert-CanonicalRunnerTaskName -TaskName ([string]$Installation.taskName))
  $task = Get-ScheduledTask -TaskName ([string]$Installation.taskName) -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    throw "GitHub runner scheduled task is not installed."
  }
  $expectedScript = Join-Path $RepositoryRoot "scripts\deployment\Start-GitHubRunner.ps1"
  $actions = @($task.Actions)
  if (
    $actions.Count -ne 1 -or
    -not [string]::Equals(
      [string]$actions[0].Execute,
      [string]$Installation.powerShellPath,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$actions[0].Arguments -notlike "*`"$expectedScript`"*"
  ) {
    throw "GitHub runner task does not match the pinned repository-scoped launcher."
  }
  return $task
}

function Assert-PinnedRunnerBinary {
  param([Parameter(Mandatory)][hashtable]$Layout)

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Layout.RunnerRoot)
  $listener = Join-Path $Layout.RunnerRoot "bin\Runner.Listener.exe"
  foreach ($path in @(
      $listener,
      (Join-Path $Layout.RunnerRoot "config.cmd"),
      (Join-Path $Layout.RunnerRoot "run.cmd")
    )) {
    [void](Assert-ContainedPath -Root $Layout.Root -Path $path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Pinned GitHub runner file is missing: $path"
    }
  }
  $version = (& $listener --version 2>&1 | Select-Object -First 1).ToString().Trim()
  if ($LASTEXITCODE -ne 0 -or $version -cne $script:PinnedRunnerVersion) {
    throw "GitHub runner binary version must remain pinned to $script:PinnedRunnerVersion; observed $version."
  }
  return $version
}

function Test-ReleaseWebDocument {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][int]$TimeoutSeconds
  )

  $releaseIndex = Join-Path $ReleaseRoot "apps\web\dist\index.html"
  $expectedHash = (Get-FileHash -LiteralPath $releaseIndex -Algorithm SHA256).Hash.ToLowerInvariant()
  $handler = [System.Net.Http.SocketsHttpHandler]::new()
  $handler.UseProxy = $false
  $client = [System.Net.Http.HttpClient]::new($handler, $true)
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
  try {
    $bytes = $client.GetByteArrayAsync("http://127.0.0.1:8790/").GetAwaiter().GetResult()
    $actualHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ($actualHash -cne $expectedHash) {
      throw "Served web index does not match the selected release."
    }
  } finally {
    $client.Dispose()
  }
  return $expectedHash
}
