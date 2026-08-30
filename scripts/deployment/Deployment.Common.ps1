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
$script:CanonicalIcaclsPath = "C:\Windows\System32\icacls.exe"
$script:CanonicalControllerVersion = "1.0.0"
$script:CanonicalDeploymentTaskDescription = "Supervises the loopback-only Unified AI Orchestrator release selected by the repository deployment pointer."
$script:CanonicalRunnerTaskDescription = "Pinned repository-scoped GitHub Actions runner for Unified AI Orchestrator local production."
$script:PinnedRunnerVersion = "2.337.0"
$script:PinnedRunnerArchiveSha256 = "1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc"
$script:PinnedRunnerArchiveUrl = "https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip"
$script:PinnedNodeVersion = "22.23.2"
$script:PinnedNodeArchiveName = "node-v22.23.2-win-x64.zip"
$script:PinnedNodeArchiveSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
$script:PinnedNodeArchiveUrl = "https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip"
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
  $acquired = $false
  $abandoned = $false
  try {
    $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
    $abandoned = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    throw "Another local deployment operation holds the deployment-state lock."
  }
  Add-Member -InputObject $mutex -NotePropertyName WasAbandoned -NotePropertyValue $abandoned
  return $mutex
}

function Enter-DeploymentTransactionMutex {
  param([int]$TimeoutSeconds = 15)

  $mutex = [System.Threading.Mutex]::new($false, "Global\UnifiedAIOrchestratorDeploymentTransaction")
  $acquired = $false
  $abandoned = $false
  try {
    $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
    $abandoned = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    throw "Another deploy or rollback operation is already running."
  }
  Add-Member -InputObject $mutex -NotePropertyName WasAbandoned -NotePropertyValue $abandoned
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
    Failed = Join-Path $root "failed"
    State = Join-Path $root "state"
    Backups = Join-Path $root "backups"
    Logs = Join-Path $root "logs"
    Downloads = Join-Path $root "downloads"
    Toolchains = Join-Path $root "toolchains"
    NodeRuntimeRoot = Join-Path $root "toolchains\node-v22.23.2-win-x64"
    Controllers = Join-Path $root "controllers"
    RuntimeIntegrity = Join-Path $root "state\runtime-dependencies"
    RunnerRoot = Join-Path $root "github-runner\2.337.0"
    Current = Join-Path $root "current.json"
    Previous = Join-Path $root "previous.json"
    Pending = Join-Path $root "pending.json"
    ReleaseInstallationPending = Join-Path $root "state\release-installation-pending.json"
    Process = Join-Path $root "state\process.json"
    TaskInstallation = Join-Path $root "state\local-production-task-installation.json"
    ControllerInstallation = Join-Path $root "state\recovery-controller-installation.json"
    ControllerInstallationPending = Join-Path $root "state\recovery-controller-installation-pending.json"
    ControllerActivationPending = Join-Path $root "state\controller-activation-pending.json"
    LastKnownGoodController = Join-Path $root "state\last-known-good-controller.json"
    RunnerInstallation = Join-Path $root "state\github-runner-installation.json"
    NodeRuntimeInstallation = Join-Path $root "state\node-runtime-installation.json"
    NodeRuntimeInstallationPending = Join-Path $root "state\node-runtime-installation-pending.json"
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

function Assert-TreeContainsNoReparsePoints {
  param([Parameter(Mandatory)][string]$Root)

  if (-not (Test-Path -LiteralPath $Root)) {
    return
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Path tree root must not be a reparse point: $Root"
  }
  if (-not $rootItem.PSIsContainer) {
    return
  }
  $directories = [System.Collections.Generic.Stack[string]]::new()
  $directories.Push($rootItem.FullName)
  while ($directories.Count -gt 0) {
    $directory = $directories.Pop()
    foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Path tree contains a reparse point: $($child.FullName)"
      }
      if ($child.PSIsContainer) {
        $directories.Push($child.FullName)
      }
    }
  }
}

function Assert-NoForeignDeploymentPendingRecords {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [string[]]$AllowedPaths = @()
  )

  $allowed = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in $AllowedPaths) {
    [void]$allowed.Add([System.IO.Path]::GetFullPath($path))
  }
  $pendingRecords = [ordered]@{
    activation = $Layout.Pending
    releaseInstallation = $Layout.ReleaseInstallationPending
    controllerInstallation = $Layout.ControllerInstallationPending
    controllerActivation = $Layout.ControllerActivationPending
    nodeRuntimeInstallation = $Layout.NodeRuntimeInstallationPending
  }
  foreach ($entry in $pendingRecords.GetEnumerator()) {
    if (Test-Path -LiteralPath ([string]$entry.Value)) {
      $fullPath = [System.IO.Path]::GetFullPath([string]$entry.Value)
      if (-not $allowed.Contains($fullPath)) {
        throw "Unresolved $([string]$entry.Key) pending record blocks this transaction: $fullPath"
      }
    }
  }
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
      $Layout.Failed,
      $Layout.State,
      $Layout.Backups,
      $Layout.Logs,
      $Layout.Downloads,
      $Layout.Toolchains,
      $Layout.NodeRuntimeRoot,
      $Layout.Controllers,
      $Layout.RuntimeIntegrity,
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
      $Layout.Failed,
      $Layout.State,
      $Layout.Backups,
      $Layout.Logs,
      $Layout.Downloads,
      $Layout.Toolchains,
      $Layout.Controllers,
      $Layout.RuntimeIntegrity,
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

function ConvertFrom-DeploymentJsonHashtable {
  param([Parameter(Mandatory)][string]$Json)

  try {
    $convertFromJson = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($convertFromJson.Parameters.ContainsKey("DateKind")) {
      return ($Json | ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String)
    }
    return ($Json | ConvertFrom-Json -AsHashtable -Depth 100)
  } catch {
    throw "Invalid JSON content: $($_.Exception.Message)"
  }
}

function Read-JsonHashtable {
  param([Parameter(Mandatory)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required JSON file does not exist: $Path"
  }
  try {
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return (ConvertFrom-DeploymentJsonHashtable -Json $json)
  } catch {
    throw "Invalid JSON file $Path`: $($_.Exception.Message)"
  }
}

function Assert-UtcTimestamp {
  param(
    [Parameter(Mandatory)][string]$Value,
    [string]$Context = "timestamp"
  )

  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse(
      $Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsed
    ) -or $parsed.Offset -ne [TimeSpan]::Zero) {
    throw "$Context must be a UTC ISO-8601 timestamp."
  }
  return $parsed
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

function Assert-SafeWindowsPathSegment {
  param(
    [Parameter(Mandatory)][string]$Segment,
    [string]$Context = "path"
  )

  $hasControlCharacter = $false
  foreach ($character in $Segment.ToCharArray()) {
    if ([int][char]$character -lt 32) {
      $hasControlCharacter = $true
      break
    }
  }
  $invalidCharacters = [char[]]'<>:"/\|?*'
  $deviceName = $Segment.Split('.')[0].ToUpperInvariant()
  if (
    $Segment.Length -eq 0 -or
    $Segment.Length -gt 255 -or
    $hasControlCharacter -or
    $Segment.IndexOfAny($invalidCharacters) -ge 0 -or
    $Segment.EndsWith(".", [System.StringComparison]::Ordinal) -or
    $Segment.EndsWith(" ", [System.StringComparison]::Ordinal) -or
    $deviceName -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)$'
  ) {
    throw "Unsafe Windows $Context segment: $Segment"
  }
  return $Segment
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
  foreach ($segment in $segments) {
    [void](Assert-SafeWindowsPathSegment -Segment $segment -Context "release payload path")
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
        $manifest = ConvertFrom-DeploymentJsonHashtable -Json ($reader.ReadToEnd())
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

function Get-RuntimeDependencyTreeReceipt {
  param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha
  )

  [void](Assert-CommitSha -CommitSha $ExpectedSha)
  $releaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
  $nodeModulesRoot = [System.IO.Path]::GetFullPath((Join-Path $releaseRootFull "node_modules"))
  $expectedNodeModulesRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) "node_modules"))
  if (-not [string]::Equals($nodeModulesRoot, $expectedNodeModulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime dependency root is unsafe."
  }
  if (-not (Test-Path -LiteralPath $nodeModulesRoot -PathType Container)) {
    throw "Release dependencies are missing. Deploy the release before starting it."
  }
  $rootItem = Get-Item -LiteralPath $nodeModulesRoot -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Release node_modules cannot be a reparse point."
  }
  $releaseRootItem = Get-Item -LiteralPath $releaseRootFull -Force
  if (($releaseRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Installed release root cannot be a reparse point."
  }

  $packageLockPath = Join-Path $ReleaseRoot "package-lock.json"
  $packageLock = Read-JsonHashtable -Path $packageLockPath
  if (-not $packageLock.Contains("packages") -or $packageLock.packages -isnot [System.Collections.IDictionary]) {
    throw "Release package-lock.json does not expose workspace link contracts."
  }
  $expectedLinks = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
  foreach ($package in $packageLock.packages.GetEnumerator()) {
    if ($package.Value -isnot [System.Collections.IDictionary] -or
        -not $package.Value.Contains("link") -or
        -not [bool]$package.Value.link) {
      continue
    }
    $linkPath = ([string]$package.Key).Replace("\", "/")
    $resolved = ([string]$package.Value.resolved).Replace("\", "/")
    if ($linkPath -cnotmatch "^node_modules/@unified-ai/[a-z0-9-]+$" -or
        $resolved -cnotmatch "^(apps|packages|services)/[a-z0-9-]+$") {
      throw "Runtime workspace link contract is unsafe: $linkPath -> $resolved"
    }
    $target = [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot $resolved))
    [void](Assert-ContainedPath -Root $ReleaseRoot -Path $target)
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
      throw "Runtime workspace link target is missing: $resolved"
    }
    $expectedLinks.Add($linkPath, $target)
  }
  if ($expectedLinks.Count -eq 0 -or $expectedLinks.Count -gt 100) {
    throw "Runtime workspace link count is outside the allowed range."
  }

  $items = @(
    Get-ChildItem -LiteralPath $releaseRootFull -Recurse -Force |
      Where-Object {
        [System.IO.Path]::GetRelativePath($releaseRootFull, $_.FullName).Replace("\", "/") -cne
          "runtime-integrity.json"
      } |
      Sort-Object FullName
  )
  if ($items.Count -eq 0 -or $items.Count -gt 250000) {
    throw "Installed runtime tree item count is outside the allowed range."
  }
  $entries = [System.Collections.Generic.SortedDictionary[string,object]]::new([System.StringComparer]::Ordinal)
  $seenLinks = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($item in $items) {
    $relativePath = [System.IO.Path]::GetRelativePath($ReleaseRoot, $item.FullName).Replace("\", "/")
    if ([string]::IsNullOrWhiteSpace($relativePath) -or $relativePath.StartsWith("../", [System.StringComparison]::Ordinal)) {
      throw "Runtime dependency path escaped the release: $relativePath"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      if (-not $item.PSIsContainer -or -not $expectedLinks.ContainsKey($relativePath)) {
        throw "Runtime dependencies contain an undeclared reparse point: $relativePath"
      }
      $resolvedTarget = $item.ResolveLinkTarget($false)
      if ($null -eq $resolvedTarget -or
          -not [string]::Equals(
            [System.IO.Path]::GetFullPath($resolvedTarget.FullName),
            $expectedLinks[$relativePath],
            [System.StringComparison]::OrdinalIgnoreCase
          )) {
        throw "Runtime workspace link target does not match package-lock.json: $relativePath"
      }
      [void]$seenLinks.Add($relativePath)
      $targetRelative = [System.IO.Path]::GetRelativePath($ReleaseRoot, $expectedLinks[$relativePath]).Replace("\", "/")
      $entries.Add($relativePath, [ordered]@{ kind = "link"; target = $targetRelative })
      continue
    }
    if ($item.PSIsContainer) {
      $entries.Add($relativePath, [ordered]@{ kind = "directory" })
    } else {
      $entries.Add($relativePath, [ordered]@{ kind = "file"; item = [System.IO.FileInfo]$item })
    }
  }
  foreach ($linkPath in $expectedLinks.Keys) {
    if (-not $seenLinks.Contains($linkPath)) {
      throw "Runtime workspace link declared by package-lock.json is missing: $linkPath"
    }
  }
  $fileCount = @($entries.Values | Where-Object { [string]$_.kind -ceq "file" }).Count
  $directoryCount = @($entries.Values | Where-Object { [string]$_.kind -ceq "directory" }).Count
  if ($fileCount -eq 0 -or $fileCount -gt 200000) {
    throw "Installed runtime tree file count is outside the allowed range."
  }

  $treeHasher = [System.Security.Cryptography.IncrementalHash]::CreateHash(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  $totalBytes = [uint64]0
  try {
    foreach ($entry in $entries.GetEnumerator()) {
      $relativePath = [string]$entry.Key
      if ([string]$entry.Value.kind -ceq "directory") {
        $record = "directory`t$relativePath`n"
        $treeHasher.AppendData([System.Text.Encoding]::UTF8.GetBytes($record))
        continue
      }
      if ([string]$entry.Value.kind -ceq "link") {
        $record = "link`t$relativePath`t$([string]$entry.Value.target)`n"
        $treeHasher.AppendData([System.Text.Encoding]::UTF8.GetBytes($record))
        continue
      }
      $file = [System.IO.FileInfo]$entry.Value.item
      $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
      try {
        $fileHash = [System.Security.Cryptography.SHA256]::HashData($stream)
      } finally {
        $stream.Dispose()
      }
      $fileHashText = [System.Convert]::ToHexString($fileHash).ToLowerInvariant()
      $record = "file`t$relativePath`t$($file.Length)`t$fileHashText`n"
      $treeHasher.AppendData([System.Text.Encoding]::UTF8.GetBytes($record))
      $totalBytes += [uint64]$file.Length
    }
    $treeHash = [System.Convert]::ToHexString($treeHasher.GetHashAndReset()).ToLowerInvariant()
  } finally {
    $treeHasher.Dispose()
  }
  return [ordered]@{
    commitSha = $ExpectedSha
    entryCount = $entries.Count
    fileCount = $fileCount
    directoryCount = $directoryCount
    linkCount = $seenLinks.Count
    totalBytes = $totalBytes
    treeSha256 = $treeHash
  }
}

function Get-PinnedNodeArchivePath {
  param([Parameter(Mandatory)][hashtable]$Layout)

  return (Assert-ContainedPath `
      -Root $Layout.Downloads `
      -Path (Join-Path $Layout.Downloads $script:PinnedNodeArchiveName))
}

function Expand-PinnedNodeArchive {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  $archivePathFull = [System.IO.Path]::GetFullPath($ArchivePath)
  $destinationFull = [System.IO.Path]::GetFullPath($DestinationRoot)
  [void](Assert-ContainedPath -Root $Layout.Downloads -Path $archivePathFull)
  [void](Assert-ContainedPath -Root $Layout.Staging -Path $destinationFull)
  if ((Get-FileHash -LiteralPath $archivePathFull -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:PinnedNodeArchiveSha256) {
    throw "Pinned Node.js archive does not match the reviewed official SHA-256."
  }
  $prefix = "node-v$($script:PinnedNodeVersion)-win-x64/"
  Add-Type -AssemblyName System.IO.Compression
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePathFull)
  try {
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $fileCount = 0
    foreach ($entry in $archive.Entries) {
      $entryName = [string]$entry.FullName
      if ($entryName.Contains("\") -or
          -not $entryName.StartsWith($prefix, [System.StringComparison]::Ordinal) -or
          $entryName.Contains([char]0)) {
        throw "Pinned Node.js archive contains an unsafe path."
      }
      $relative = $entryName.Substring($prefix.Length)
      if ([string]::IsNullOrEmpty($relative)) {
        continue
      }
      $segments = $relative.TrimEnd("/").Split("/")
      if (@($segments | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
        throw "Pinned Node.js archive contains an unsafe path segment."
      }
      foreach ($segment in $segments) {
        [void](Assert-SafeWindowsPathSegment -Segment $segment -Context "Node.js archive path")
      }
      $normalizedRelative = $relative.TrimEnd("/")
      if (-not $seen.Add($normalizedRelative)) {
        throw "Pinned Node.js archive contains a duplicate path: $relative"
      }
      if ($entry.Name.Length -eq 0) {
        $directoryTarget = Assert-ContainedPath `
          -Root $destinationFull `
          -Path (Join-Path $destinationFull ($normalizedRelative.Replace("/", "\")))
        [void](New-Item -ItemType Directory -Path $directoryTarget -Force)
        continue
      }
      $fileCount += 1
      if ($fileCount -gt 10000) {
        throw "Pinned Node.js archive exceeds the reviewed payload-file limit."
      }
      if (($fileCount % 250) -eq 0) {
        Write-Host "[node-runtime] Extracted $fileCount files."
      }
      $target = Assert-ContainedPath `
        -Root $destinationFull `
        -Path (Join-Path $destinationFull ($relative.Replace("/", "\")))
      [void](New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force)
      $input = $entry.Open()
      try {
        $output = [System.IO.File]::Open(
          $target,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None
        )
        try {
          $input.CopyTo($output)
        } finally {
          $output.Dispose()
        }
      } finally {
        $input.Dispose()
      }
    }
    if ($fileCount -lt 1) {
      throw "Pinned Node.js archive has no payload files."
    }
  } finally {
    $archive.Dispose()
  }
}

function Test-PinnedNodeRuntime {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [int]$ExpectedFileCount = 0,
    [string]$ExpectedTreeSha256,
    [switch]$ExecuteVersionChecks
  )

  $runtimeRootFull = [System.IO.Path]::GetFullPath($RuntimeRoot)
  [void](Assert-ContainedPath -Root $Layout.Root -Path $runtimeRootFull)
  $archivePath = Get-PinnedNodeArchivePath -Layout $Layout
  foreach ($path in @($runtimeRootFull, $archivePath)) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Pinned Node.js source or runtime is missing: $path"
    }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Pinned Node.js source and runtime cannot be reparse points."
    }
  }
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:PinnedNodeArchiveSha256) {
    throw "Stored Node.js archive no longer matches its reviewed official SHA-256."
  }

  $prefix = "node-v$($script:PinnedNodeVersion)-win-x64/"
  Add-Type -AssemblyName System.IO.Compression
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $seenEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $expectedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $expectedDirectories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @($archive.Entries | Sort-Object -Property FullName -CaseSensitive)) {
      $entryName = [string]$entry.FullName
      if ($entryName.Contains("\") -or
          -not $entryName.StartsWith($prefix, [System.StringComparison]::Ordinal) -or
          $entryName.Contains([char]0)) {
        throw "Pinned Node.js archive inventory contains an unsafe path."
      }
      $relative = $entryName.Substring($prefix.Length)
      if ([string]::IsNullOrEmpty($relative)) {
        continue
      }
      $trimmedRelative = $relative.TrimEnd("/")
      $segments = $trimmedRelative.Split("/")
      if (@($segments | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
        throw "Pinned Node.js archive inventory contains an unsafe or duplicate path."
      }
      if (-not $seenEntries.Add($trimmedRelative)) {
        throw "Pinned Node.js archive inventory contains an unsafe or duplicate path."
      }
      foreach ($segment in $segments) {
        [void](Assert-SafeWindowsPathSegment -Segment $segment -Context "Node.js archive path")
      }
      $directorySegmentCount = if ($entry.Name.Length -eq 0) { $segments.Count } else { $segments.Count - 1 }
      for ($index = 0; $index -lt $directorySegmentCount; $index += 1) {
        [void]$expectedDirectories.Add(($segments[0..$index] -join "/"))
      }
      if ($entry.Name.Length -eq 0) {
        continue
      }
      if (-not $expectedFiles.Add($relative)) {
        throw "Pinned Node.js archive inventory contains an unsafe or duplicate path."
      }
      if ($expectedFiles.Count -gt 10000) {
        throw "Pinned Node.js archive exceeds the reviewed payload-file limit."
      }
      if (($expectedFiles.Count % 250) -eq 0) {
        Write-Host "[node-runtime] Verified $($expectedFiles.Count) archive files."
      }
      $installedPath = Assert-ContainedPath `
        -Root $runtimeRootFull `
        -Path (Join-Path $runtimeRootFull ($relative.Replace("/", "\")))
      if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
        throw "Pinned Node.js payload file is missing: $relative"
      }
      $installedItem = Get-Item -LiteralPath $installedPath -Force
      if (($installedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          [int64]$installedItem.Length -ne [int64]$entry.Length) {
        throw "Pinned Node.js payload entry is not a matching regular file: $relative"
      }
      $entryStream = $entry.Open()
      try {
        $entryHash = [Convert]::ToHexString(
          [System.Security.Cryptography.SHA256]::HashData($entryStream)
        ).ToLowerInvariant()
      } finally {
        $entryStream.Dispose()
      }
      $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($installedHash -cne $entryHash) {
        throw "Pinned Node.js payload SHA-256 mismatch: $relative"
      }
      $lines.Add("$relative`t$([int64]$entry.Length)`t$entryHash")
    }
  } finally {
    $archive.Dispose()
  }
  $installedFiles = 0
  $installedDirectories = 0
  foreach ($item in @(Get-ChildItem -LiteralPath $runtimeRootFull -Recurse -Force)) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Pinned Node.js runtime contains a reparse point: $($item.FullName)"
    }
    $relative = [System.IO.Path]::GetRelativePath($runtimeRootFull, $item.FullName).Replace("\", "/")
    if ($item.PSIsContainer) {
      $installedDirectories += 1
      if (-not $expectedDirectories.Contains($relative)) {
        throw "Pinned Node.js runtime contains an undeclared directory: $relative"
      }
    } else {
      $installedFiles += 1
      if (($installedFiles % 250) -eq 0) {
        Write-Host "[node-runtime] Inventoried $installedFiles installed files."
      }
      if (-not $expectedFiles.Contains($relative)) {
        throw "Pinned Node.js runtime contains an undeclared file: $relative"
      }
    }
  }
  if ($installedFiles -ne $lines.Count -or
      $installedDirectories -ne $expectedDirectories.Count -or
      $lines.Count -lt 1) {
    throw "Pinned Node.js runtime payload file or directory count does not match the reviewed archive."
  }
  $treeBytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $treeSha256 = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData($treeBytes)
  ).ToLowerInvariant()
  if ($ExpectedFileCount -gt 0 -and $lines.Count -ne $ExpectedFileCount) {
    throw "Pinned Node.js runtime payload file count drifted."
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTreeSha256) -and
      ($ExpectedTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or $treeSha256 -cne $ExpectedTreeSha256)) {
    throw "Pinned Node.js runtime payload tree SHA-256 drifted."
  }
  $nodePath = Join-Path $runtimeRootFull "node.exe"
  $npmPath = Join-Path $runtimeRootFull "npm.cmd"
  if ($ExecuteVersionChecks) {
    $nodeVersion = Assert-NodeRuntime -NodePath $nodePath
    if ($nodeVersion -cne "v$($script:PinnedNodeVersion)") {
      throw "Pinned Node.js runtime version drifted: $nodeVersion"
    }
    $npmOutput = @(& $npmPath --version 2>&1)
    $npmExitCode = $LASTEXITCODE
    $npmVersion = ($npmOutput | Select-Object -First 1).ToString().Trim()
    if ($npmExitCode -ne 0 -or $npmVersion -cne "10.9.8") {
      throw "Pinned npm runtime version drifted."
    }
  }
  return [ordered]@{
    version = $script:PinnedNodeVersion
    archiveSha256 = $script:PinnedNodeArchiveSha256
    fileCount = $lines.Count
    treeSha256 = $treeSha256
    runtimeRoot = $runtimeRootFull
    nodePath = $nodePath
    npmPath = $npmPath
  }
}

function Protect-PinnedNodeRuntime {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  [void](Assert-ContainedPath -Root $Layout.Toolchains -Path $Layout.NodeRuntimeRoot)
  $aclOutput = & $script:CanonicalIcaclsPath $Layout.NodeRuntimeRoot /reset /T /C /Q 2>&1
  if ($LASTEXITCODE -eq 0) {
    $aclOutput += & $script:CanonicalIcaclsPath $Layout.NodeRuntimeRoot /inheritance:r /grant:r "*$($IdentitySid):(OI)(CI)RX" "*S-1-5-18:(OI)(CI)F" /Q 2>&1
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to seal pinned Node.js runtime read-only: $($aclOutput -join [Environment]::NewLine)"
  }
  return (Assert-ProtectedAclContract `
      -Path $Layout.NodeRuntimeRoot `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute `
      -Recursive)
}

function Read-PinnedNodeRuntimeInstallation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [switch]$ExecuteVersionChecks
  )

  $state = Read-JsonHashtable -Path $Layout.NodeRuntimeInstallation
  $requiredKeys = @(
    "schemaVersion", "version", "archiveSha256", "payloadFileCount", "payloadTreeSha256",
    "runtimeRoot", "nodePath", "npmPath", "identityName", "identitySid", "installedAtUtc"
  )
  if (@($state.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $state.Keys }).Count -ne 0 -or
      [int]$state.schemaVersion -ne 1 -or
      [string]$state.version -cne $script:PinnedNodeVersion -or
      [string]$state.archiveSha256 -cne $script:PinnedNodeArchiveSha256 -or
      [int]$state.payloadFileCount -lt 1 -or
      [string]$state.payloadTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$state.runtimeRoot -cne $Layout.NodeRuntimeRoot -or
      [string]$state.nodePath -cne (Join-Path $Layout.NodeRuntimeRoot "node.exe") -or
      [string]$state.npmPath -cne (Join-Path $Layout.NodeRuntimeRoot "npm.cmd") -or
      [string]$state.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Pinned Node.js installation state does not match the reviewed D-backed runtime contract."
  }
  [void](Assert-UtcTimestamp -Value ([string]$state.installedAtUtc) -Context "Node.js runtime installedAtUtc")
  $identity = Get-CurrentWindowsIdentityReceipt
  if ([string]$state.identitySid -cne [string]$identity.identitySid) {
    throw "Pinned Node.js runtime was installed for a different Windows identity."
  }
  $runtime = Test-PinnedNodeRuntime `
    -Layout $Layout `
    -RuntimeRoot ([string]$state.runtimeRoot) `
    -ExpectedFileCount ([int]$state.payloadFileCount) `
    -ExpectedTreeSha256 ([string]$state.payloadTreeSha256) `
    -ExecuteVersionChecks:$ExecuteVersionChecks
  [void](Assert-ProtectedAclContract `
      -Path ([string]$state.runtimeRoot) `
      -IdentitySid ([string]$state.identitySid) `
      -IdentityAccess ReadAndExecute `
      -Recursive)
  foreach ($key in $runtime.Keys) {
    $state[$key] = $runtime[$key]
  }
  return $state
}

function Write-RuntimeDependencyIntegrity {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$NpmPath
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $ReleaseRoot)
  $releaseManifest = Test-ReleaseDirectory -Layout $Layout -ReleaseRoot $ReleaseRoot -ExpectedSha $ExpectedSha
  $NodePath = [System.IO.Path]::GetFullPath($NodePath)
  $NpmPath = [System.IO.Path]::GetFullPath($NpmPath)
  $nodeRuntime = Read-PinnedNodeRuntimeInstallation -Layout $Layout -ExecuteVersionChecks
  if (-not [string]::Equals($NodePath, [string]$nodeRuntime.nodePath, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($NpmPath, [string]$nodeRuntime.npmPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release installation must use the qualified D-backed Node.js runtime."
  }
  $nodeVersion = Assert-NodeRuntime -NodePath $NodePath
  if ($nodeVersion -cne "v22.23.2") {
    throw "Release installation requires the exact Node.js runtime v22.23.2; observed $nodeVersion."
  }
  $npmOutput = @(& $NpmPath --version 2>&1)
  $npmExitCode = $LASTEXITCODE
  $npmVersion = ($npmOutput | Select-Object -First 1).ToString().Trim()
  if ($npmExitCode -ne 0 -or $npmVersion -cne "10.9.8") {
    throw "Unable to attest the pinned npm 10.9.8 runtime."
  }
  $tree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $ReleaseRoot -ExpectedSha $ExpectedSha
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User -or [string]::IsNullOrWhiteSpace($identity.Name)) {
    throw "Unable to resolve the release installation identity."
  }
  $receipt = [ordered]@{
    schemaVersion = 3
    commitSha = $ExpectedSha
    packageLockSha256 = [string]$releaseManifest.packageLockSha256
    nodePath = $NodePath
    nodeVersion = $nodeVersion
    nodeSha256 = (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    nodeRuntimeArchiveSha256 = [string]$nodeRuntime.archiveSha256
    nodeRuntimeFileCount = [int]$nodeRuntime.payloadFileCount
    nodeRuntimeTreeSha256 = [string]$nodeRuntime.payloadTreeSha256
    identityName = $identity.Name
    identitySid = $identity.User.Value
    entryCount = [int]$tree.entryCount
    fileCount = [int]$tree.fileCount
    directoryCount = [int]$tree.directoryCount
    linkCount = [int]$tree.linkCount
    totalBytes = [uint64]$tree.totalBytes
    treeSha256 = [string]$tree.treeSha256
  }
  $receiptPath = Join-Path $ReleaseRoot "runtime-integrity.json"
  Write-AtomicJson -Layout $Layout -Path $receiptPath -Value $receipt
  $receiptSha256 = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $sealPath = Assert-ContainedPath `
    -Root $Layout.RuntimeIntegrity `
    -Path (Join-Path $Layout.RuntimeIntegrity "$ExpectedSha.json")
  if (Test-Path -LiteralPath $sealPath) {
    throw "Runtime dependency integrity seal already exists; immutable releases cannot be resealed."
  }
  Write-AtomicJson -Layout $Layout -Path $sealPath -Value ([ordered]@{
      schemaVersion = 1
      commitSha = $ExpectedSha
      runtimeIntegritySha256 = $receiptSha256
      treeSha256 = [string]$tree.treeSha256
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    })
  $sealAclOutput = & $script:CanonicalIcaclsPath $sealPath /inheritance:r /grant:r "*$($identity.User.Value):RX" "*S-1-5-18:F" /Q 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to seal runtime dependency receipt: $($sealAclOutput -join [Environment]::NewLine)"
  }
  [void](Assert-IntegritySealProtection -Path $sealPath -IdentitySid $identity.User.Value)
  $receipt["runtimeIntegritySha256"] = $receiptSha256
  return $receipt
}

function Test-RuntimeDependencyIntegrity {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [string]$ExpectedReceiptSha256
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $ReleaseRoot)
  $releaseManifest = Test-ReleaseDirectory -Layout $Layout -ReleaseRoot $ReleaseRoot -ExpectedSha $ExpectedSha
  $receiptPath = Join-Path $ReleaseRoot "runtime-integrity.json"
  $receipt = Read-JsonHashtable -Path $receiptPath
  $requiredKeys = @(
    "schemaVersion", "commitSha", "packageLockSha256", "nodePath", "nodeVersion",
    "nodeSha256", "nodeRuntimeArchiveSha256", "nodeRuntimeFileCount", "nodeRuntimeTreeSha256",
    "identityName", "identitySid",
    "entryCount", "fileCount", "directoryCount", "linkCount", "totalBytes", "treeSha256"
  )
  if (@($receipt.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $receipt.Keys }).Count -ne 0 -or
      [int]$receipt.schemaVersion -ne 3 -or
      [string]$receipt.commitSha -cne $ExpectedSha -or
      [string]$receipt.packageLockSha256 -cne [string]$releaseManifest.packageLockSha256 -or
      [string]$receipt.nodeVersion -cne "v22.23.2" -or
      [string]$receipt.nodeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$receipt.nodeRuntimeArchiveSha256 -cne $script:PinnedNodeArchiveSha256 -or
      [int]$receipt.nodeRuntimeFileCount -lt 1 -or
      [string]$receipt.nodeRuntimeTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$receipt.identitySid -cnotmatch "^S-1-[0-9-]+$" -or
      [string]$receipt.treeSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Runtime dependency integrity receipt does not match the selected release."
  }
  $sealPath = Assert-ContainedPath `
    -Root $Layout.RuntimeIntegrity `
    -Path (Join-Path $Layout.RuntimeIntegrity "$ExpectedSha.json")
  $seal = Read-JsonHashtable -Path $sealPath
  [void](Assert-IntegritySealProtection -Path $sealPath -IdentitySid ([string]$receipt.identitySid))
  $sealKeys = @("schemaVersion", "commitSha", "runtimeIntegritySha256", "treeSha256", "createdAtUtc")
  $receiptSha256 = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($ExpectedReceiptSha256) -and
      ($ExpectedReceiptSha256 -cnotmatch "^[0-9a-f]{64}$" -or $receiptSha256 -cne $ExpectedReceiptSha256)) {
    throw "Runtime dependency receipt does not match the release pointer."
  }
  if (@($seal.Keys | Where-Object { $_ -notin $sealKeys }).Count -ne 0 -or
      @($sealKeys | Where-Object { $_ -notin $seal.Keys }).Count -ne 0 -or
      [int]$seal.schemaVersion -ne 1 -or
      [string]$seal.commitSha -cne $ExpectedSha -or
      [string]$seal.runtimeIntegritySha256 -cne $receiptSha256 -or
      [string]$seal.treeSha256 -cne [string]$receipt.treeSha256) {
    throw "External runtime dependency seal does not match the immutable release receipt."
  }
  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  if ([string]$receipt.identitySid -cne [string]$currentIdentity.identitySid) {
    throw "Runtime dependencies were installed by a different Windows identity."
  }
  $nodeRuntime = Read-PinnedNodeRuntimeInstallation -Layout $Layout
  if ([int]$receipt.nodeRuntimeFileCount -ne [int]$nodeRuntime.payloadFileCount -or
      [string]$receipt.nodeRuntimeTreeSha256 -cne [string]$nodeRuntime.payloadTreeSha256 -or
      -not [string]::Equals(
        [string]$receipt.nodePath,
        [string]$nodeRuntime.nodePath,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "Release runtime receipt is not bound to the qualified D-backed Node.js runtime."
  }
  $nodePath = [string]$receipt.nodePath
  if (-not [System.IO.Path]::IsPathFullyQualified($nodePath) -or
      -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "Recorded Node.js runtime executable is unavailable."
  }
  $nodeItem = Get-Item -LiteralPath $nodePath -Force
  if (($nodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
      (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.nodeSha256) {
    throw "Pinned Node.js runtime failed integrity verification."
  }
  $tree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $ReleaseRoot -ExpectedSha $ExpectedSha
  if ([int]$receipt.entryCount -ne [int]$tree.entryCount -or
      [int]$receipt.fileCount -ne [int]$tree.fileCount -or
      [int]$receipt.directoryCount -ne [int]$tree.directoryCount -or
      [int]$receipt.linkCount -ne [int]$tree.linkCount -or
      [uint64]$receipt.totalBytes -ne [uint64]$tree.totalBytes -or
      [string]$receipt.treeSha256 -cne [string]$tree.treeSha256) {
    throw "Installed runtime dependency tree failed SHA-256 integrity verification."
  }
  $receipt["runtimeIntegritySha256"] = $receiptSha256
  return $receipt
}

function Assert-ProtectedAclContract {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$IdentitySid,
    [Parameter(Mandatory)][ValidateSet("ReadAndExecute", "FullControl")][string]$IdentityAccess,
    [switch]$Recursive
  )

  if (-not (Test-Path -LiteralPath $script:CanonicalIcaclsPath -PathType Leaf)) {
    throw "Pinned Windows ACL utility is unavailable: $script:CanonicalIcaclsPath"
  }
  if (-not (Test-Path -LiteralPath $Path) -or $IdentitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Protected ACL path or identity is invalid."
  }
  $paths = [System.Collections.Generic.List[string]]::new()
  $paths.Add([System.IO.Path]::GetFullPath($Path))
  if ($Recursive) {
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force)) {
      $paths.Add([System.IO.Path]::GetFullPath($item.FullName))
    }
  }
  if ($paths.Count -gt 300000) {
    throw "Protected ACL tree exceeds the reviewed validation limit."
  }
  $expectedSids = @($IdentitySid, "S-1-5-18")
  $writeRights = [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  for ($pathIndex = 0; $pathIndex -lt $paths.Count; $pathIndex++) {
    $protectedPath = $paths[$pathIndex]
    $isRootPath = $pathIndex -eq 0
    $acl = Get-Acl -LiteralPath $protectedPath
    if (($isRootPath -and -not $acl.AreAccessRulesProtected) -or
        (-not $isRootPath -and $acl.AreAccessRulesProtected)) {
      throw "Protected ACL inheritance state is incorrect: $protectedPath"
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($rule in @($acl.Access)) {
      $sid = try {
        $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      } catch {
        throw "Protected ACL contains an unresolvable identity: $protectedPath"
      }
      if ([string]$rule.AccessControlType -cne "Allow" -or
          [bool]$rule.IsInherited -ne (-not $isRootPath) -or
          $sid -notin $expectedSids -or
          -not $seen.Add($sid)) {
        throw "Protected ACL contains an unexpected, inherited, or duplicate rule for $sid at $protectedPath."
      }
      $rights = [System.Security.AccessControl.FileSystemRights]$rule.FileSystemRights
      if ($sid -ceq "S-1-5-18") {
        if (($rights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
          throw "Protected ACL does not grant LocalSystem full control: $protectedPath"
        }
      } elseif ($IdentityAccess -ceq "FullControl") {
        if (($rights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
          throw "Protected ACL does not grant the runtime identity full control: $protectedPath"
        }
      } elseif (($rights -band [System.Security.AccessControl.FileSystemRights]::ReadAndExecute) -ne [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -or
          ($rights -band $writeRights) -ne 0) {
        throw "Protected ACL does not restrict the runtime identity to read and execute: $protectedPath"
      }
    }
    foreach ($sid in $expectedSids) {
      if (-not $seen.Contains($sid)) {
        throw "Protected ACL is missing required identity $sid at $protectedPath."
      }
    }
  }
  return $true
}

function Assert-IntegritySealProtection {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  return (Assert-ProtectedAclContract `
      -Path $Path `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute)
}

function Protect-ReleaseDirectory {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  [void](Assert-ContainedPath -Root $Layout.Releases -Path $ReleaseRoot)
  if ($IdentitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Release protection identity SID is invalid."
  }
  $aclOutput = & $script:CanonicalIcaclsPath $ReleaseRoot /reset /T /C /Q 2>&1
  if ($LASTEXITCODE -eq 0) {
    $aclOutput += & $script:CanonicalIcaclsPath $ReleaseRoot /inheritance:r /grant:r "*$($IdentitySid):(OI)(CI)RX" "*S-1-5-18:(OI)(CI)F" /Q 2>&1
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to seal release directory read-only: $($aclOutput -join [Environment]::NewLine)"
  }
  [void](Assert-ReleaseDirectoryProtection -Layout $Layout -ReleaseRoot $ReleaseRoot -IdentitySid $IdentitySid)
}

function Assert-ReleaseDirectoryProtection {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  [void](Assert-ContainedPath -Root $Layout.Releases -Path $ReleaseRoot)
  return (Assert-ProtectedAclContract `
      -Path $ReleaseRoot `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute `
      -Recursive)
}

function Test-RecoveryControllerManifest {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$SourceRoot
  )

  $source = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd("\")
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Recovery controller source does not exist: $source"
  }
  $sourceItem = Get-Item -LiteralPath $source -Force
  if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Recovery controller source cannot be a reparse point."
  }
  $manifestPath = Join-Path $source "controller-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Recovery controller manifest is missing."
  }
  $manifestItem = Get-Item -LiteralPath $manifestPath -Force
  if (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Recovery controller manifest cannot be a reparse point."
  }
  $manifest = Read-JsonHashtable -Path $manifestPath
  $requiredKeys = @("schemaVersion", "controllerVersion", "files")
  $requiredFiles = @(
    "Deployment.Common.ps1",
    "Start-LocalRelease.ps1",
    "Stop-LocalRelease.ps1",
    "Rollback-LocalRelease.ps1",
    "Test-LocalRelease.ps1",
    "Test-LocalAiRuntime.ps1"
  )
  if (@($manifest.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $manifest.Keys }).Count -ne 0 -or
      [int]$manifest.schemaVersion -ne 1 -or
      [string]$manifest.controllerVersion -cne $script:CanonicalControllerVersion -or
      $manifest.files -isnot [System.Collections.IDictionary] -or
      @($manifest.files.Keys | Where-Object { $_ -notin $requiredFiles }).Count -ne 0 -or
      @($requiredFiles | Where-Object { $_ -notin $manifest.files.Keys }).Count -ne 0) {
    throw "Recovery controller manifest does not match the pinned controller contract."
  }
  foreach ($name in $requiredFiles) {
    if ($name -cnotmatch "^[A-Za-z0-9.-]+$" -or [string]$manifest.files[$name] -cnotmatch "^[0-9a-f]{64}$") {
      throw "Recovery controller manifest contains an invalid file contract."
    }
    $path = [System.IO.Path]::GetFullPath((Join-Path $source $name))
    $relative = [System.IO.Path]::GetRelativePath($source, $path)
    if ($relative.Contains("\") -or $relative.Contains("/") -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Recovery controller file is missing or outside the flat bundle: $name"
    }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Recovery controller files cannot be reparse points: $name"
    }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne [string]$manifest.files[$name]) {
      throw "Recovery controller hash mismatch for $name."
    }
  }
  return [ordered]@{
    schemaVersion = 1
    controllerVersion = [string]$manifest.controllerVersion
    controllerManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceRoot = $source
    files = $manifest.files
  }
}

function Get-RecoveryControllerRoot {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ControllerVersion,
    [Parameter(Mandatory)][string]$ControllerManifestSha256
  )

  if ($ControllerVersion -cne $script:CanonicalControllerVersion -or
      $ControllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Recovery controller identity is invalid."
  }
  return (Assert-ContainedPath `
      -Root $Layout.Controllers `
      -Path (Join-Path $Layout.Controllers "$ControllerVersion-$ControllerManifestSha256"))
}

function Assert-RecoveryControllerProtection {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ControllerRoot,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  [void](Assert-ContainedPath -Root $Layout.Controllers -Path $ControllerRoot)
  return (Assert-ProtectedAclContract `
      -Path $ControllerRoot `
      -IdentitySid $IdentitySid `
      -IdentityAccess ReadAndExecute `
      -Recursive)
}

function Test-InstalledRecoveryController {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$ControllerRoot,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory)][string]$IdentitySid
  )

  $receipt = Test-RecoveryControllerManifest -Layout $Layout -SourceRoot $ControllerRoot
  $expectedRoot = Get-RecoveryControllerRoot `
    -Layout $Layout `
    -ControllerVersion ([string]$receipt.controllerVersion) `
    -ControllerManifestSha256 $ExpectedManifestSha256
  if (-not [string]::Equals($ControllerRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]$receipt.controllerManifestSha256 -cne $ExpectedManifestSha256) {
    throw "Installed recovery controller identity does not match its contained manifest."
  }
  $expectedEntries = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($name in @($receipt.files.Keys) + @("controller-manifest.json")) {
    [void]$expectedEntries.Add([string]$name)
  }
  $actualEntries = @(Get-ChildItem -LiteralPath $ControllerRoot -Force)
  if ($actualEntries.Count -ne $expectedEntries.Count) {
    throw "Installed recovery controller must contain exactly the six scripts and manifest."
  }
  foreach ($entry in $actualEntries) {
    if ($entry.PSIsContainer -or
        ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not $expectedEntries.Contains($entry.Name)) {
      throw "Installed recovery controller contains an undeclared or unsafe entry: $($entry.Name)"
    }
  }
  [void](Assert-RecoveryControllerProtection `
      -Layout $Layout `
      -ControllerRoot $ControllerRoot `
      -IdentitySid $IdentitySid)
  return $receipt
}

function Assert-RecoveryControllerInstallationValue {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][System.Collections.IDictionary]$State
  )

  $requiredKeys = @(
    "schemaVersion", "controllerVersion", "controllerManifestSha256", "controllerRoot",
    "identityName", "identitySid", "installedAtUtc"
  )
  if (@($State.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $State.Keys }).Count -ne 0 -or
      [int]$State.schemaVersion -ne 1 -or
      [string]$State.controllerVersion -cne $script:CanonicalControllerVersion -or
      [string]$State.controllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$State.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Recovery controller installation state does not match the pinned contract."
  }
  [void](Assert-UtcTimestamp -Value ([string]$State.installedAtUtc) -Context "Recovery controller installedAtUtc")
  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  if ([string]$State.identitySid -cne [string]$currentIdentity.identitySid) {
    throw "Recovery controller was installed for a different Windows identity."
  }
  [void](Test-InstalledRecoveryController `
      -Layout $Layout `
      -ControllerRoot ([string]$State.controllerRoot) `
      -ExpectedManifestSha256 ([string]$State.controllerManifestSha256) `
      -IdentitySid ([string]$State.identitySid))
  return $State
}

function Read-RecoveryControllerInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.ControllerInstallation
  return (Assert-RecoveryControllerInstallationValue -Layout $Layout -State $state)
}

function Assert-LastKnownGoodRecoveryControllerValue {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Pointer
  )

  $requiredKeys = @(
    "schemaVersion", "controllerVersion", "controllerManifestSha256", "controllerRoot",
    "qualifiedReleaseSha", "qualifiedAtUtc"
  )
  if (@($Pointer.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $Pointer.Keys }).Count -ne 0 -or
      [int]$Pointer.schemaVersion -ne 1 -or
      [string]$Pointer.controllerVersion -cne $script:CanonicalControllerVersion -or
      [string]$Pointer.controllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$Pointer.qualifiedReleaseSha -cnotmatch $script:ShaPattern) {
    throw "Last-known-good recovery controller pointer is invalid."
  }
  [void](Assert-UtcTimestamp -Value ([string]$Pointer.qualifiedAtUtc) -Context "Recovery controller qualifiedAtUtc")
  $identity = Get-CurrentWindowsIdentityReceipt
  [void](Test-InstalledRecoveryController `
      -Layout $Layout `
      -ControllerRoot ([string]$Pointer.controllerRoot) `
      -ExpectedManifestSha256 ([string]$Pointer.controllerManifestSha256) `
      -IdentitySid ([string]$identity.identitySid))
  return $Pointer
}

function Read-LastKnownGoodRecoveryController {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $pointer = Read-JsonHashtable -Path $Layout.LastKnownGoodController
  return (Assert-LastKnownGoodRecoveryControllerValue -Layout $Layout -Pointer $pointer)
}

function Set-LastKnownGoodRecoveryController {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$QualifiedReleaseSha,
    [Parameter(Mandatory)][string]$TaskName
  )

  [void](Assert-CommitSha -CommitSha $QualifiedReleaseSha)
  $installation = Read-RecoveryControllerInstallation -Layout $Layout
  $current = Read-ReleasePointer -Path $Layout.Current
  if ([string]$current.commitSha -cne $QualifiedReleaseSha) {
    throw "Recovery controller can be qualified only for the active release."
  }
  $releaseRoot = Get-ReleaseRoot -Layout $Layout -CommitSha $QualifiedReleaseSha
  [void](Test-ReleaseDirectory -Layout $Layout -ReleaseRoot $releaseRoot -ExpectedSha $QualifiedReleaseSha)
  $runtimeReceipt = Test-RuntimeDependencyIntegrity `
    -Layout $Layout `
    -ReleaseRoot $releaseRoot `
    -ExpectedSha $QualifiedReleaseSha `
    -ExpectedReceiptSha256 ([string]$current.runtimeDependencyReceiptSha256)
  [void](Assert-ReleaseDirectoryProtection `
      -Layout $Layout `
      -ReleaseRoot $releaseRoot `
      -IdentitySid ([string]$runtimeReceipt.identitySid))
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  if ($null -eq (Get-LiveReleaseProcess -Layout $Layout -ExpectedSha $QualifiedReleaseSha)) {
    throw "Recovery controller cannot be qualified without the exact live release process."
  }
  $pointer = [ordered]@{
    schemaVersion = 1
    controllerVersion = [string]$installation.controllerVersion
    controllerManifestSha256 = [string]$installation.controllerManifestSha256
    controllerRoot = [string]$installation.controllerRoot
    qualifiedReleaseSha = $QualifiedReleaseSha
    qualifiedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-AtomicJson -Layout $Layout -Path $Layout.LastKnownGoodController -Value $pointer
  [void](Read-LastKnownGoodRecoveryController -Layout $Layout)
  return $pointer
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
    [Parameter(Mandatory)][string]$Reason,
    [Parameter(Mandatory)][string]$RuntimeDependencyReceiptSha256
  )

  if ($RuntimeDependencyReceiptSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Release pointer runtime dependency receipt SHA-256 is invalid."
  }
  return [ordered]@{
    schemaVersion = 2
    commitSha = $CommitSha
    runtimeDependencyReceiptSha256 = $RuntimeDependencyReceiptSha256
    activatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    reason = $Reason
  }
}

function Assert-ReleasePointerValue {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$Pointer,
    [string]$Context = "release pointer"
  )

  $requiredKeys = @(
    "schemaVersion", "commitSha", "runtimeDependencyReceiptSha256", "activatedAtUtc", "reason"
  )
  if (@($Pointer.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $Pointer.Keys }).Count -ne 0 -or
      [int]$Pointer.schemaVersion -ne 2 -or
      [string]$Pointer.runtimeDependencyReceiptSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]::IsNullOrWhiteSpace([string]$Pointer.reason)) {
    throw "Invalid $Context."
  }
  [void](Assert-CommitSha -CommitSha ([string]$Pointer.commitSha))
  [void](Assert-UtcTimestamp -Value ([string]$Pointer.activatedAtUtc) -Context "$Context activatedAtUtc")
  return $Pointer
}

function Read-ReleasePointer {
  param([Parameter(Mandatory)][string]$Path)

  $pointer = Read-JsonHashtable -Path $Path
  return (Assert-ReleasePointerValue -Pointer $pointer -Context "release pointer $Path")
}

function Backup-DeploymentState {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$OperationId
  )

  if ($OperationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$") {
    throw "Unsafe deployment operation id."
  }
  $stateMutex = Enter-DeploymentMutex
  try {
    $backupRoot = Assert-ContainedPath -Root $Layout.Backups -Path (Join-Path $Layout.Backups $OperationId)
    [void](New-Item -ItemType Directory -Path $backupRoot)
    $statePaths = @(
      $Layout.Current,
      $Layout.Previous,
      $Layout.Pending,
      $Layout.Process,
      $Layout.LastKnownGoodController,
      $Layout.ControllerInstallation,
      $Layout.TaskInstallation
    )
    $entries = [ordered]@{}
    foreach ($statePath in $statePaths) {
      $name = [System.IO.Path]::GetFileName($statePath)
      $present = Test-Path -LiteralPath $statePath -PathType Leaf
      $backupPath = Join-Path $backupRoot $name
      if ($present) {
        Copy-Item -LiteralPath $statePath -Destination $backupPath
      }
      $entries[$name] = [ordered]@{
        present = $present
        sha256 = if ($present) {
          (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } else {
          $null
        }
      }
    }
    Write-AtomicJson -Layout $Layout -Path (Join-Path $backupRoot "backup.json") -Value ([ordered]@{
        schemaVersion = 3
        operationId = $OperationId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        scope = "activation-state"
        entries = $entries
      })
    return $backupRoot
  } finally {
    Exit-DeploymentMutex -Mutex $stateMutex
  }
}

function Read-DeploymentStateBackup {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256
  )

  if ($OperationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      $ExpectedManifestSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Deployment activation backup identity is invalid."
  }
  $backupRoot = Assert-ContainedPath -Root $Layout.Backups -Path (Join-Path $Layout.Backups $OperationId)
  $manifestPath = Join-Path $backupRoot "backup.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
      (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedManifestSha256) {
    throw "Deployment activation backup manifest is missing or failed SHA-256 verification."
  }
  $manifest = Read-JsonHashtable -Path $manifestPath
  $requiredKeys = @("schemaVersion", "operationId", "createdAtUtc", "scope", "entries")
  $expectedNames = @(
    "current.json",
    "previous.json",
    "pending.json",
    "process.json",
    "last-known-good-controller.json",
    "recovery-controller-installation.json",
    "local-production-task-installation.json"
  )
  if (@($manifest.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $manifest.Keys }).Count -ne 0 -or
      [int]$manifest.schemaVersion -ne 3 -or
      [string]$manifest.operationId -cne $OperationId -or
      [string]$manifest.scope -cne "activation-state" -or
      $manifest.entries -isnot [System.Collections.IDictionary] -or
      @($manifest.entries.Keys | Where-Object { $_ -notin $expectedNames }).Count -ne 0 -or
      @($expectedNames | Where-Object { $_ -notin $manifest.entries.Keys }).Count -ne 0) {
    throw "Deployment activation backup manifest does not match the exact state contract."
  }
  [void](Assert-UtcTimestamp -Value ([string]$manifest.createdAtUtc) -Context "Deployment backup createdAtUtc")
  foreach ($name in $expectedNames) {
    $entry = $manifest.entries[$name]
    if ($entry -isnot [System.Collections.IDictionary] -or
        @($entry.Keys | Where-Object { $_ -notin @("present", "sha256") }).Count -ne 0 -or
        -not $entry.Contains("present") -or
        -not $entry.Contains("sha256")) {
      throw "Deployment activation backup entry is invalid: $name"
    }
    $path = Join-Path $backupRoot $name
    if ([bool]$entry.present) {
      if ([string]$entry.sha256 -cnotmatch "^[0-9a-f]{64}$" -or
          -not (Test-Path -LiteralPath $path -PathType Leaf) -or
          (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$entry.sha256) {
        throw "Deployment activation backup entry failed SHA-256 verification: $name"
      }
      [void](Read-JsonHashtable -Path $path)
    } elseif ($null -ne $entry.sha256 -or (Test-Path -LiteralPath $path)) {
      throw "Deployment activation backup contains an undeclared state file: $name"
    }
  }
  return [ordered]@{
    backupRoot = $backupRoot
    manifestPath = $manifestPath
    manifestSha256 = $ExpectedManifestSha256
    manifest = $manifest
  }
}

function Restore-DeploymentStateBackup {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256
  )

  $backup = Read-DeploymentStateBackup `
    -Layout $Layout `
    -OperationId $OperationId `
    -ExpectedManifestSha256 $ExpectedManifestSha256
  $targets = [ordered]@{
    "current.json" = $Layout.Current
    "previous.json" = $Layout.Previous
    "last-known-good-controller.json" = $Layout.LastKnownGoodController
  }
  foreach ($mapping in $targets.GetEnumerator()) {
    $entry = $backup.manifest.entries[[string]$mapping.Key]
    $targetPath = [string]$mapping.Value
    if ([bool]$entry.present) {
      $value = Read-JsonHashtable -Path (Join-Path $backup.backupRoot ([string]$mapping.Key))
      Write-AtomicJson -Layout $Layout -Path $targetPath -Value $value
    } elseif (Test-Path -LiteralPath $targetPath -PathType Leaf) {
      Remove-Item -LiteralPath $targetPath -Force
    }
  }
  return $backup
}

function Read-DeploymentActivationPending {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $pending = Read-JsonHashtable -Path $Layout.Pending
  $requiredKeys = @(
    "schemaVersion", "action", "commitSha", "operationId", "createdAtUtc", "state",
    "backupRoot", "backupManifestSha256"
  )
  if (@($pending.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $pending.Keys }).Count -ne 0 -or
      [int]$pending.schemaVersion -ne 2 -or
      [string]$pending.action -notin @("deploy", "rollback") -or
      [string]$pending.operationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      [string]$pending.backupManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$pending.state -notin @("activating", "rolling-back") -or
      ([string]$pending.action -ceq "deploy" -and [string]$pending.state -cne "activating") -or
      ([string]$pending.action -ceq "rollback" -and [string]$pending.state -cne "rolling-back")) {
    throw "Pending deployment activation record is invalid."
  }
  [void](Assert-UtcTimestamp -Value ([string]$pending.createdAtUtc) -Context "Pending deployment createdAtUtc")
  [void](Assert-CommitSha -CommitSha ([string]$pending.commitSha))
  $expectedBackupRoot = Assert-ContainedPath `
    -Root $Layout.Backups `
    -Path (Join-Path $Layout.Backups ([string]$pending.operationId))
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$pending.backupRoot),
      $expectedBackupRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Pending deployment activation record references an unexpected backup root."
  }
  [void](Read-DeploymentStateBackup `
      -Layout $Layout `
      -OperationId ([string]$pending.operationId) `
      -ExpectedManifestSha256 ([string]$pending.backupManifestSha256))
  return $pending
}

function Recover-InterruptedDeploymentActivation {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$HealthUri,
    [Parameter(Mandatory)][int]$HealthTimeoutSeconds
  )

  if (-not (Test-Path -LiteralPath $Layout.Pending -PathType Leaf)) {
    return $null
  }
  if (Test-Path -LiteralPath $Layout.ReleaseInstallationPending -PathType Leaf) {
    throw "Release installation and activation pending records coexist; refusing ambiguous recovery."
  }
  [void](Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot)
  [void](Assert-CanonicalTaskName -TaskName $TaskName)
  [void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
  $pending = Read-DeploymentActivationPending -Layout $Layout
  $backup = Read-DeploymentStateBackup `
    -Layout $Layout `
    -OperationId ([string]$pending.operationId) `
    -ExpectedManifestSha256 ([string]$pending.backupManifestSha256)
  $priorCurrent = $null
  $currentEntry = $backup.manifest.entries["current.json"]
  if ([bool]$currentEntry.present) {
    $priorCurrent = Read-ReleasePointer -Path (Join-Path $backup.backupRoot "current.json")
    $priorReleaseRoot = Get-ReleaseRoot -Layout $Layout -CommitSha ([string]$priorCurrent.commitSha)
    [void](Test-ReleaseDirectory `
        -Layout $Layout `
        -ReleaseRoot $priorReleaseRoot `
        -ExpectedSha ([string]$priorCurrent.commitSha))
    $priorRuntimeReceipt = Test-RuntimeDependencyIntegrity `
      -Layout $Layout `
      -ReleaseRoot $priorReleaseRoot `
      -ExpectedSha ([string]$priorCurrent.commitSha) `
      -ExpectedReceiptSha256 ([string]$priorCurrent.runtimeDependencyReceiptSha256)
    [void](Assert-ReleaseDirectoryProtection `
        -Layout $Layout `
        -ReleaseRoot $priorReleaseRoot `
        -IdentitySid ([string]$priorRuntimeReceipt.identitySid))
  }
  if ([bool]$backup.manifest.entries["previous.json"].present) {
    [void](Read-ReleasePointer -Path (Join-Path $backup.backupRoot "previous.json"))
  }
  $controllerRoot = $null
  if ([bool]$backup.manifest.entries["last-known-good-controller.json"].present) {
    $priorController = Read-JsonHashtable -Path (Join-Path $backup.backupRoot "last-known-good-controller.json")
    [void](Assert-LastKnownGoodRecoveryControllerValue -Layout $Layout -Pointer $priorController)
    if ($null -ne $priorCurrent -and
        [string]$priorController.qualifiedReleaseSha -cne [string]$priorCurrent.commitSha) {
      throw "Activation backup recovery controller is not qualified for the prior current release."
    }
    $controllerRoot = [string]$priorController.controllerRoot
  } else {
    $controllerEntry = $backup.manifest.entries["recovery-controller-installation.json"]
    if (-not [bool]$controllerEntry.present) {
      throw "Activation backup has no installed recovery controller for first-deployment recovery."
    }
    $controllerInstallation = Read-JsonHashtable `
      -Path (Join-Path $backup.backupRoot "recovery-controller-installation.json")
    [void](Assert-RecoveryControllerInstallationValue `
        -Layout $Layout `
        -State $controllerInstallation)
    $controllerRoot = [string]$controllerInstallation.controllerRoot
  }
  $stopScriptFull = Assert-ContainedPath `
    -Root $controllerRoot `
    -Path (Join-Path $controllerRoot "Stop-LocalRelease.ps1")
  if (-not (Test-Path -LiteralPath $stopScriptFull -PathType Leaf)) {
    throw "Activation backup recovery controller has no reviewed stop script."
  }
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  & $stopScriptFull `
    -RepositoryRoot $RepositoryRoot `
    -TaskName $TaskName `
    -Confirm:$false
  [void](Restore-DeploymentStateBackup `
      -Layout $Layout `
      -OperationId ([string]$pending.operationId) `
      -ExpectedManifestSha256 ([string]$pending.backupManifestSha256))
  if (Test-Path -LiteralPath $Layout.Current -PathType Leaf) {
    $restoredCurrent = Read-ReleasePointer -Path $Layout.Current
    Start-ScheduledTask -TaskName $TaskName
    [void](Wait-ForReleaseHealth `
        -HealthUri $HealthUri `
        -ExpectedSha ([string]$restoredCurrent.commitSha) `
        -TimeoutSeconds $HealthTimeoutSeconds)
    [void](Test-ReleaseWebDocument -ReleaseRoot $priorReleaseRoot -TimeoutSeconds 10)
    $restoredLive = Get-LiveReleaseProcess `
      -Layout $Layout `
      -ExpectedSha ([string]$restoredCurrent.commitSha)
    if ($null -eq $restoredLive) {
      throw "Activation recovery readiness passed without the exact restored release process."
    }
  }
  if (Test-Path -LiteralPath $Layout.Previous -PathType Leaf) {
    [void](Read-ReleasePointer -Path $Layout.Previous)
  }
  if (Test-Path -LiteralPath $Layout.LastKnownGoodController -PathType Leaf) {
    [void](Read-LastKnownGoodRecoveryController -Layout $Layout)
  }
  if (Test-Path -LiteralPath $Layout.Pending -PathType Leaf) {
    Remove-Item -LiteralPath $Layout.Pending -Force
  }
  try {
    Write-DeploymentEvent `
      -Layout $Layout `
      -Action "activation-recovery" `
      -Status "succeeded" `
      -CommitSha ([string]$pending.commitSha) `
      -OperationId ([string]$pending.operationId) `
      -Message "Recovered interrupted $([string]$pending.action) activation to its exact pre-operation pointers."
  } catch {
    Write-Warning "Activation recovery committed but event logging failed: $($_.Exception.Message)"
  }
  return $pending
}

function Read-ReleaseInstallationPending {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $pending = Read-JsonHashtable -Path $Layout.ReleaseInstallationPending
  $requiredKeys = @(
    "schemaVersion", "commitSha", "operationId", "createdAtUtc", "state",
    "artifactSha256", "releaseRoot", "stagingRoot"
  )
  if (@($pending.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $pending.Keys }).Count -ne 0 -or
      [int]$pending.schemaVersion -ne 1 -or
      [string]$pending.operationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      [string]$pending.state -cne "installing" -or
      [string]$pending.artifactSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Pending release installation record is invalid."
  }
  [void](Assert-UtcTimestamp -Value ([string]$pending.createdAtUtc) -Context "Pending release installation createdAtUtc")
  $commitSha = Assert-CommitSha -CommitSha ([string]$pending.commitSha)
  $expectedReleaseRoot = Get-ReleaseRoot -Layout $Layout -CommitSha $commitSha
  $expectedStagingRoot = Assert-ContainedPath `
    -Root $Layout.Staging `
    -Path (Join-Path $Layout.Staging "$commitSha-$([string]$pending.operationId)")
  foreach ($comparison in @(
      @([string]$pending.releaseRoot, $expectedReleaseRoot),
      @([string]$pending.stagingRoot, $expectedStagingRoot)
    )) {
    if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath($comparison[0]),
        [System.IO.Path]::GetFullPath($comparison[1]),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Pending release installation record references an unexpected path."
    }
  }
  return $pending
}

function Assert-ReleaseInstallationIsUnreferenced {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$CommitSha
  )

  foreach ($pointerPath in @($Layout.Current, $Layout.Previous)) {
    if (Test-Path -LiteralPath $pointerPath -PathType Leaf) {
      $pointer = Read-ReleasePointer -Path $pointerPath
      if ([string]$pointer.commitSha -ceq $CommitSha) {
        throw "Interrupted release installation $CommitSha is still referenced by $pointerPath."
      }
    }
  }
  if (Test-Path -LiteralPath $Layout.LastKnownGoodController -PathType Leaf) {
    $controller = Read-LastKnownGoodRecoveryController -Layout $Layout
    if ([string]$controller.qualifiedReleaseSha -ceq $CommitSha) {
      throw "Interrupted release installation $CommitSha is still referenced by the recovery controller."
    }
  }
  if (Test-Path -LiteralPath $Layout.Process -PathType Leaf) {
    [void](Get-LiveReleaseProcess -Layout $Layout)
    $processReceipt = Read-JsonHashtable -Path $Layout.Process
    if ([string]$processReceipt.commitSha -ceq $CommitSha) {
      throw "Interrupted release installation $CommitSha is still referenced by the process receipt."
    }
  }
}

function Move-InterruptedReleasePathToFailed {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$AllowedRoot,
    [Parameter(Mandatory)][string]$Name
  )

  if (-not (Test-Path -LiteralPath $SourceRoot)) {
    return $null
  }
  [void](Assert-ContainedPath -Root $AllowedRoot -Path $SourceRoot)
  [void](Assert-TreeContainsNoReparsePoints -Root $SourceRoot)
  $item = Get-Item -LiteralPath $SourceRoot -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Interrupted release path is a reparse point and cannot be quarantined: $SourceRoot"
  }
  $destination = Assert-ContainedPath -Root $Layout.Failed -Path (Join-Path $Layout.Failed $Name)
  if (Test-Path -LiteralPath $destination) {
    throw "Interrupted release quarantine target already exists: $destination"
  }
  Move-Item -LiteralPath $SourceRoot -Destination $destination
  return $destination
}

function Recover-InterruptedReleaseInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  if (-not (Test-Path -LiteralPath $Layout.ReleaseInstallationPending -PathType Leaf)) {
    return $null
  }
  if (Test-Path -LiteralPath $Layout.Pending -PathType Leaf) {
    throw "Release installation and activation pending records coexist; refusing ambiguous recovery."
  }
  $pending = Read-ReleaseInstallationPending -Layout $Layout
  $commitSha = [string]$pending.commitSha
  Assert-ReleaseInstallationIsUnreferenced -Layout $Layout -CommitSha $commitSha
  $releaseRoot = [string]$pending.releaseRoot
  $stagingRoot = [string]$pending.stagingRoot
  $operationId = [string]$pending.operationId
  $completed = $false
  if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
    try {
      [void](Test-ReleaseDirectory -Layout $Layout -ReleaseRoot $releaseRoot -ExpectedSha $commitSha)
      $runtimeReceipt = Test-RuntimeDependencyIntegrity -Layout $Layout -ReleaseRoot $releaseRoot -ExpectedSha $commitSha
      [void](Assert-ReleaseDirectoryProtection `
          -Layout $Layout `
          -ReleaseRoot $releaseRoot `
          -IdentitySid ([string]$runtimeReceipt.identitySid))
      $completed = $true
    } catch {
      $completed = $false
    }
  }
  $quarantined = [System.Collections.Generic.List[string]]::new()
  if (-not $completed) {
    $failedRelease = Move-InterruptedReleasePathToFailed `
      -Layout $Layout `
      -SourceRoot $releaseRoot `
      -AllowedRoot $Layout.Releases `
      -Name "$commitSha-$operationId-release"
    if ($null -ne $failedRelease) {
      $quarantined.Add($failedRelease)
    }
    $sealPath = Assert-ContainedPath `
      -Root $Layout.RuntimeIntegrity `
      -Path (Join-Path $Layout.RuntimeIntegrity "$commitSha.json")
    if (Test-Path -LiteralPath $sealPath -PathType Leaf) {
      $identity = Get-CurrentWindowsIdentityReceipt
      $aclOutput = & $script:CanonicalIcaclsPath $sealPath /inheritance:e /grant:r "*$([string]$identity.identitySid):F" /Q 2>&1
      if ($LASTEXITCODE -ne 0) {
        throw "Unable to reopen interrupted runtime seal for quarantine: $($aclOutput -join [Environment]::NewLine)"
      }
      $failedSeal = Assert-ContainedPath `
        -Root $Layout.Failed `
        -Path (Join-Path $Layout.Failed "$commitSha-$operationId-runtime-integrity.json")
      Move-Item -LiteralPath $sealPath -Destination $failedSeal
      $quarantined.Add($failedSeal)
    }
  }
  $failedStaging = Move-InterruptedReleasePathToFailed `
    -Layout $Layout `
    -SourceRoot $stagingRoot `
    -AllowedRoot $Layout.Staging `
    -Name "$commitSha-$operationId-staging"
  if ($null -ne $failedStaging) {
    $quarantined.Add($failedStaging)
  }
  $recoveredRecord = Assert-ContainedPath `
    -Root $Layout.Failed `
    -Path (Join-Path $Layout.Failed "release-installation-$operationId-recovered.json")
  if (Test-Path -LiteralPath $recoveredRecord) {
    throw "Release-installation recovery record already exists: $recoveredRecord"
  }
  Move-Item -LiteralPath $Layout.ReleaseInstallationPending -Destination $recoveredRecord
  try {
    Write-DeploymentEvent `
      -Layout $Layout `
      -Action "release-installation-recovery" `
      -Status "succeeded" `
      -CommitSha $commitSha `
      -OperationId $operationId `
      -Message $(if ($completed) {
          "Recovered a fully qualified interrupted release installation."
        } else {
          "Quarantined an incomplete interrupted release installation."
        })
  } catch {
    Write-Warning "Release-installation recovery committed but event logging failed: $($_.Exception.Message)"
  }
  return [ordered]@{
    commitSha = $commitSha
    completed = $completed
    quarantined = @($quarantined)
    recoveryRecord = $recoveredRecord
  }
}

function Read-OptionalJsonState {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Path
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Path)
  $present = Test-Path -LiteralPath $Path -PathType Leaf
  return [ordered]@{
    present = $present
    value = if ($present) { Read-JsonHashtable -Path $Path } else { $null }
  }
}

function Restore-OptionalJsonState {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Snapshot
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Path)
  if (-not $Snapshot.Contains("present") -or -not $Snapshot.Contains("value")) {
    throw "Optional state snapshot is invalid."
  }
  if ([bool]$Snapshot.present) {
    if ($Snapshot.value -isnot [System.Collections.IDictionary]) {
      throw "Present optional state snapshot has no JSON object value."
    }
    Write-AtomicJson -Layout $Layout -Path $Path -Value ([System.Collections.IDictionary]$Snapshot.value)
  } elseif (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force
  }
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

  $versionOutput = @(& $NodePath --version 2>&1)
  $exitCode = $LASTEXITCODE
  $version = ($versionOutput | Select-Object -First 1).ToString().Trim()
  if ($exitCode -ne 0 -or $version -notmatch "^v(?<major>\d+)\.\d+\.\d+") {
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
  $requiredKeys = @(
    "schemaVersion", "commitSha", "pid", "entrypoint", "nodePath", "nodeVersion",
    "nodeSha256", "runtimeDependencyReceiptSha256", "startedAtUtc", "stdoutPath",
    "stderrPath", "supervised"
  )
  if (@($receipt.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $receipt.Keys }).Count -ne 0) {
    throw "Process receipt does not match the exact runtime contract."
  }
  if ([int]$receipt.schemaVersion -ne 2 -or
      [string]$receipt.nodeVersion -cne "v22.23.2" -or
      [string]$receipt.nodeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$receipt.runtimeDependencyReceiptSha256 -cnotmatch "^[0-9a-f]{64}$") {
    throw "Unsupported process receipt schemaVersion."
  }
  [void](Assert-CommitSha -CommitSha ([string]$receipt.commitSha))
  if ($ExpectedSha -and [string]$receipt.commitSha -cne $ExpectedSha) {
    throw "Live process receipt SHA does not match the selected release."
  }
  [void](Assert-ContainedPath -Root $Layout.Releases -Path ([string]$receipt.entrypoint))
  [void](Assert-ContainedPath -Root $Layout.Logs -Path ([string]$receipt.stdoutPath))
  [void](Assert-ContainedPath -Root $Layout.Logs -Path ([string]$receipt.stderrPath))
  if (-not (Test-Path -LiteralPath ([string]$receipt.nodePath) -PathType Leaf) -or
      (Get-FileHash -LiteralPath ([string]$receipt.nodePath) -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.nodeSha256) {
    throw "Process receipt Node.js runtime failed SHA-256 verification."
  }
  if (Test-Path -LiteralPath $Layout.Current -PathType Leaf) {
    $currentPointer = Read-ReleasePointer -Path $Layout.Current
    if ([string]$currentPointer.commitSha -ceq [string]$receipt.commitSha -and
        [string]$currentPointer.runtimeDependencyReceiptSha256 -cne [string]$receipt.runtimeDependencyReceiptSha256) {
      throw "Process receipt runtime dependency identity does not match the current release pointer."
    }
  }
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
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 300) {
    throw "Health timeout must be from 1 to 300 seconds."
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

function ConvertTo-WindowsSid {
  param([Parameter(Mandatory)][string]$Identity)

  if ([string]::IsNullOrWhiteSpace($Identity)) {
    throw "Windows identity cannot be empty."
  }
  if ($Identity -cmatch "^S-1-[0-9-]+$") {
    try {
      return ([System.Security.Principal.SecurityIdentifier]::new($Identity)).Value
    } catch {
      throw "Windows SID is invalid: $Identity"
    }
  }
  try {
    return ([System.Security.Principal.NTAccount]::new($Identity)).Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    throw "Unable to resolve Windows identity '$Identity' to a SID."
  }
}

function Get-CurrentWindowsIdentityReceipt {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User -or [string]::IsNullOrWhiteSpace($identity.Name)) {
    throw "Unable to resolve the current Windows identity."
  }
  return [ordered]@{
    identityName = $identity.Name
    identitySid = $identity.User.Value
  }
}

function Assert-ScheduledTaskDefinition {
  param(
    [Parameter(Mandatory)][object]$Task,
    [Parameter(Mandatory)][string]$ExpectedTaskName,
    [Parameter(Mandatory)][string]$ExpectedExecute,
    [Parameter(Mandatory)][string]$ExpectedArguments,
    [Parameter(Mandatory)][string]$ExpectedIdentitySid,
    [Parameter(Mandatory)][string]$ExpectedDescription
  )

  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  if ([string]$currentIdentity.identitySid -cne $ExpectedIdentitySid) {
    throw "Scheduled task identity SID does not match the currently executing user."
  }
  if ([string]$Task.TaskName -cne $ExpectedTaskName -or [string]$Task.TaskPath -cne "\") {
    throw "Scheduled task must use the exact name $ExpectedTaskName at root task path \."
  }
  if ([string]$Task.Description -cne $ExpectedDescription) {
    throw "Scheduled task description does not match the reviewed contract."
  }

  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) {
    throw "Scheduled task $ExpectedTaskName must have exactly one action."
  }
  $action = $actions[0]
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$action.Execute),
      [System.IO.Path]::GetFullPath($ExpectedExecute),
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$action.Arguments -cne $ExpectedArguments -or
    -not [string]::IsNullOrWhiteSpace([string]$action.WorkingDirectory)) {
    throw "Scheduled task $ExpectedTaskName action does not match the exact launcher contract."
  }

  $principalSid = ConvertTo-WindowsSid -Identity ([string]$Task.Principal.UserId)
  if ($principalSid -cne $ExpectedIdentitySid -or
      [string]$Task.Principal.LogonType -cne "Interactive" -or
      [string]$Task.Principal.RunLevel -cne "Limited" -or
      [string]$Task.Principal.ProcessTokenSidType -cne "Default" -or
      -not [string]::IsNullOrWhiteSpace([string]$Task.Principal.RequiredPrivilege) -or
      -not [string]::IsNullOrWhiteSpace([string]$Task.Principal.GroupId)) {
    throw "Scheduled task $ExpectedTaskName principal does not match the password-free current-user contract."
  }

  $triggers = @($Task.Triggers)
  if ($triggers.Count -ne 1) {
    throw "Scheduled task $ExpectedTaskName must have exactly one trigger."
  }
  $trigger = $triggers[0]
  $triggerClass = [string]$trigger.CimClass.CimClassName
  $triggerSid = ConvertTo-WindowsSid -Identity ([string]$trigger.UserId)
  $repetitionInvalid = $false
  if ($null -ne $trigger.Repetition) {
    $repetitionInvalid = (
      -not [string]::IsNullOrWhiteSpace([string]$trigger.Repetition.Duration) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.Repetition.Interval) -or
      [bool]$trigger.Repetition.StopAtDurationEnd
    )
  }
  if ($triggerClass -cne "MSFT_TaskLogonTrigger" -or
      -not [bool]$trigger.Enabled -or
      $triggerSid -cne $ExpectedIdentitySid -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.Delay) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.StartBoundary) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.EndBoundary) -or
      -not [string]::IsNullOrWhiteSpace([string]$trigger.ExecutionTimeLimit) -or
      $repetitionInvalid) {
    throw "Scheduled task $ExpectedTaskName logon trigger does not match the exact current-user contract."
  }

  $settings = $Task.Settings
  if ($null -eq $settings -or
      [int]$settings.RestartCount -ne 3 -or
      [string]$settings.RestartInterval -cne "PT1M" -or
      [string]$settings.ExecutionTimeLimit -cne "P3650D" -or
      [string]$settings.MultipleInstances -cne "IgnoreNew" -or
      [string]$settings.Compatibility -cne "Win7" -or
      -not [bool]$settings.AllowDemandStart -or
      -not [bool]$settings.AllowHardTerminate -or
      -not [bool]$settings.Enabled -or
      [int]$settings.Priority -ne 7 -or
      -not [bool]$settings.Hidden -or
      -not [bool]$settings.StartWhenAvailable -or
      [bool]$settings.DisallowStartIfOnBatteries -or
      [bool]$settings.StopIfGoingOnBatteries -or
      [bool]$settings.RunOnlyIfIdle -or
      [bool]$settings.RunOnlyIfNetworkAvailable -or
      [bool]$settings.WakeToRun -or
      [bool]$settings.DisallowStartOnRemoteAppSession -or
      -not [bool]$settings.UseUnifiedSchedulingEngine -or
      [bool]$settings.volatile -or
      $null -ne $settings.MaintenanceSettings -or
      -not [string]::IsNullOrWhiteSpace([string]$settings.DeleteExpiredTaskAfter) -or
      [string]$settings.IdleSettings.IdleDuration -cne "PT10M" -or
      [bool]$settings.IdleSettings.RestartOnIdle -or
      -not [bool]$settings.IdleSettings.StopOnIdleEnd -or
      [string]$settings.IdleSettings.WaitTimeout -cne "PT1H" -or
      -not [string]::IsNullOrWhiteSpace([string]$settings.NetworkSettings.Id) -or
      -not [string]::IsNullOrWhiteSpace([string]$settings.NetworkSettings.Name)) {
    throw "Scheduled task $ExpectedTaskName settings do not match the exact supervision contract."
  }
  return $Task
}

function Assert-ScheduledTaskContract {
  param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$ExpectedExecute,
    [Parameter(Mandatory)][string]$ExpectedArguments,
    [Parameter(Mandatory)][string]$ExpectedIdentitySid,
    [Parameter(Mandatory)][string]$ExpectedDescription
  )

  $tasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($tasks.Count -ne 1) {
    throw "Expected exactly one scheduled task named $TaskName; found $($tasks.Count)."
  }
  return (Assert-ScheduledTaskDefinition `
      -Task $tasks[0] `
      -ExpectedTaskName $TaskName `
      -ExpectedExecute $ExpectedExecute `
      -ExpectedArguments $ExpectedArguments `
      -ExpectedIdentitySid $ExpectedIdentitySid `
      -ExpectedDescription $ExpectedDescription)
}

function Read-DeploymentTaskInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.TaskInstallation
  $requiredKeys = @(
    "schemaVersion", "repositoryRoot", "taskName", "powerShellPath", "arguments",
    "startScript", "controllerVersion", "controllerManifestSha256", "identityName",
    "identitySid", "installedAtUtc"
  )
  if (@($state.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $state.Keys }).Count -ne 0 -or
      [int]$state.schemaVersion -ne 1 -or
      [string]$state.repositoryRoot -cne $script:CanonicalRepositoryRoot -or
      [string]$state.taskName -cne $script:CanonicalTaskName -or
      [string]$state.controllerVersion -cne $script:CanonicalControllerVersion -or
      [string]$state.controllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$state.identitySid -cnotmatch "^S-1-[0-9-]+$") {
    throw "Local-production task installation state does not match the pinned contract."
  }
  [void](Assert-ContainedPath -Root $Layout.Controllers -Path ([string]$state.startScript))
  if (-not (Test-Path -LiteralPath ([string]$state.startScript) -PathType Leaf) -or
      -not (Test-Path -LiteralPath ([string]$state.powerShellPath) -PathType Leaf)) {
    throw "Local-production task installation references a missing launcher or PowerShell executable."
  }
  $controller = Read-RecoveryControllerInstallation -Layout $Layout
  $expectedStartScript = Join-Path ([string]$controller.controllerRoot) "Start-LocalRelease.ps1"
  $expectedPowerShell = Get-StableExecutable -Name "pwsh.exe"
  $expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$expectedStartScript`" -RepositoryRoot `"$script:CanonicalRepositoryRoot`" -Supervised"
  if ([string]$state.controllerVersion -cne [string]$controller.controllerVersion -or
      [string]$state.controllerManifestSha256 -cne [string]$controller.controllerManifestSha256 -or
      -not [string]::Equals([string]$state.startScript, $expectedStartScript, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$state.powerShellPath, $expectedPowerShell, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]$state.arguments -cne $expectedArguments -or
      (ConvertTo-WindowsSid -Identity ([string]$state.identityName)) -cne [string]$state.identitySid) {
    throw "Local-production task installation state drifted from the immutable recovery controller."
  }
  return $state
}

function Assert-DeploymentTaskRegistration {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$TaskName
  )

  [void](Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot)
  [void](Assert-CanonicalTaskName -TaskName $TaskName)
  $layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
  $installation = Read-DeploymentTaskInstallation -Layout $layout
  return (Assert-ScheduledTaskContract `
      -TaskName $TaskName `
      -ExpectedExecute ([string]$installation.powerShellPath) `
      -ExpectedArguments ([string]$installation.arguments) `
      -ExpectedIdentitySid ([string]$installation.identitySid) `
      -ExpectedDescription $script:CanonicalDeploymentTaskDescription)
}

function Read-GitHubRunnerInstallation {
  param([Parameter(Mandatory)][hashtable]$Layout)

  $state = Read-JsonHashtable -Path $Layout.RunnerInstallation
  foreach ($key in @(
      "schemaVersion",
      "version",
      "archiveSha256",
      "payloadFileCount",
      "payloadTreeSha256",
      "repositoryUrl",
      "labels",
      "runnerName",
      "runnerRoot",
      "taskName",
      "powerShellPath",
      "arguments",
      "identityName",
      "identitySid",
      "configured",
      "installedAtUtc"
    )) {
    if (-not $state.Contains($key)) {
      throw "GitHub runner installation state is missing $key."
    }
  }
  if (
    [int]$state.schemaVersion -ne 3 -or
    [string]$state.version -cne $script:PinnedRunnerVersion -or
    [string]$state.archiveSha256 -cne $script:PinnedRunnerArchiveSha256 -or
    [int]$state.payloadFileCount -lt 1 -or
    [string]$state.payloadTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
    [string]$state.repositoryUrl -cne $script:CanonicalRunnerRepositoryUrl -or
    [string]$state.taskName -cne $script:CanonicalRunnerTaskName -or
    [string]$state.runnerRoot -cne $Layout.RunnerRoot -or
    [string]$state.identitySid -cnotmatch "^S-1-[0-9-]+$" -or
    @($state.labels).Count -ne 1 -or
    [string](@($state.labels)[0]) -cne "unified-ai-orchestrator"
  ) {
    throw "GitHub runner installation state does not match the pinned repository contract."
  }
  [void](Assert-ContainedPath -Root $Layout.Root -Path ([string]$state.runnerRoot))
  if (-not (Test-Path -LiteralPath ([string]$state.powerShellPath) -PathType Leaf)) {
    throw "The PowerShell executable recorded for the GitHub runner task is unavailable."
  }
  $currentIdentity = Get-CurrentWindowsIdentityReceipt
  $expectedScript = Join-Path $script:CanonicalRepositoryRoot "scripts\deployment\Start-GitHubRunner.ps1"
  $expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$expectedScript`" -RepositoryRoot `"$script:CanonicalRepositoryRoot`""
  if ([string]$state.identitySid -cne [string]$currentIdentity.identitySid -or
      (ConvertTo-WindowsSid -Identity ([string]$state.identityName)) -cne [string]$state.identitySid -or
      [string]$state.arguments -cne $expectedArguments -or
      -not [string]::Equals(
        [string]$state.powerShellPath,
        (Get-StableExecutable -Name "pwsh.exe"),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "GitHub runner task installation identity or launcher arguments drifted."
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
  [void](Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot)
  return (Assert-ScheduledTaskContract `
      -TaskName ([string]$Installation.taskName) `
      -ExpectedExecute ([string]$Installation.powerShellPath) `
      -ExpectedArguments ([string]$Installation.arguments) `
      -ExpectedIdentitySid ([string]$Installation.identitySid) `
      -ExpectedDescription $script:CanonicalRunnerTaskDescription)
}

function Assert-PinnedRunnerBinary {
  param(
    [Parameter(Mandatory)][hashtable]$Layout,
    [int]$ExpectedFileCount = 0,
    [string]$ExpectedTreeSha256
  )

  [void](Assert-ContainedPath -Root $Layout.Root -Path $Layout.RunnerRoot)
  $archivePath = Assert-ContainedPath `
    -Root $Layout.Downloads `
    -Path (Join-Path $Layout.Downloads "actions-runner-win-x64-$($script:PinnedRunnerVersion).zip")
  foreach ($rootPath in @($Layout.RunnerRoot, $archivePath)) {
    $rootItem = Get-Item -LiteralPath $rootPath -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Pinned GitHub runner source and destination cannot be reparse points."
    }
  }
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:PinnedRunnerArchiveSha256) {
    throw "Stored GitHub runner archive no longer matches its pinned official SHA-256."
  }

  Add-Type -AssemblyName System.IO.Compression
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @($archive.Entries | Sort-Object -Property FullName -CaseSensitive)) {
      if ($entry.Name.Length -eq 0) {
        continue
      }
      $relative = [string]$entry.FullName
      $segments = $relative.Split("/")
      if ($relative.Contains("\") -or
          $relative.StartsWith("/") -or
          $relative.Contains([char]0) -or
          @($segments | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0 -or
          -not $seen.Add($relative)) {
        throw "Pinned GitHub runner archive inventory contains an unsafe or duplicate path."
      }
      $installedPath = Assert-ContainedPath `
        -Root $Layout.RunnerRoot `
        -Path (Join-Path $Layout.RunnerRoot ($relative.Replace("/", "\")))
      if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
        throw "Pinned GitHub runner payload file is missing: $relative"
      }
      $installedItem = Get-Item -LiteralPath $installedPath -Force
      if (($installedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          [int64]$installedItem.Length -ne [int64]$entry.Length) {
        throw "Pinned GitHub runner payload entry is not a matching regular file: $relative"
      }
      $entryStream = $entry.Open()
      try {
        $entryHash = [Convert]::ToHexString(
          [System.Security.Cryptography.SHA256]::HashData($entryStream)
        ).ToLowerInvariant()
      } finally {
        $entryStream.Dispose()
      }
      $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($installedHash -cne $entryHash) {
        throw "Pinned GitHub runner payload SHA-256 mismatch: $relative"
      }
      $lines.Add("$relative`t$([int64]$entry.Length)`t$entryHash")
    }
    if ($lines.Count -lt 1) {
      throw "Pinned GitHub runner archive has no payload files."
    }
    $treeBytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $treeSha256 = [Convert]::ToHexString(
      [System.Security.Cryptography.SHA256]::HashData($treeBytes)
    ).ToLowerInvariant()
  } finally {
    $archive.Dispose()
  }
  if ($ExpectedFileCount -gt 0 -and $lines.Count -ne $ExpectedFileCount) {
    throw "Pinned GitHub runner payload file count drifted."
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTreeSha256) -and
      ($ExpectedTreeSha256 -cnotmatch "^[0-9a-f]{64}$" -or $treeSha256 -cne $ExpectedTreeSha256)) {
    throw "Pinned GitHub runner payload tree SHA-256 drifted."
  }
  return [ordered]@{
    version = $script:PinnedRunnerVersion
    fileCount = $lines.Count
    treeSha256 = $treeSha256
  }
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
