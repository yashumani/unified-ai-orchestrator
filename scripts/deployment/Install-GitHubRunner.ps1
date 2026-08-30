#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [SecureString]$RegistrationToken,
  [string]$RunnerName = "$env:COMPUTERNAME-unified-ai-orchestrator",
  [string]$TaskName = "UnifiedAIOrchestrator-GitHubRunner"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$ownedRegistrationToken = $false
$registrationTokenFromEnvironment = [Environment]::GetEnvironmentVariable("ACTIONS_RUNNER_REGISTRATION_TOKEN", "Process")
[Environment]::SetEnvironmentVariable("ACTIONS_RUNNER_REGISTRATION_TOKEN", $null, "Process")
if ($null -ne $RegistrationToken -and -not [string]::IsNullOrWhiteSpace($registrationTokenFromEnvironment)) {
  $registrationTokenFromEnvironment = $null
  throw "Supply the runner registration token through either SecureString or ACTIONS_RUNNER_REGISTRATION_TOKEN, not both."
}
if ($null -eq $RegistrationToken -and -not [string]::IsNullOrWhiteSpace($registrationTokenFromEnvironment)) {
  try {
    $RegistrationToken = ConvertTo-SecureString -String $registrationTokenFromEnvironment -AsPlainText -Force
    $ownedRegistrationToken = $true
  } finally {
    $registrationTokenFromEnvironment = $null
  }
}
$registrationTokenFromEnvironment = $null

try {
function Expand-PinnedRunnerArchive {
  param(
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $archive.Entries) {
      $relative = $entry.FullName
      $segments = $relative.TrimEnd("/").Split("/")
      $hasUnsafeSegment = @($segments | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0
      if (
        $relative.Contains("\") -or
        $relative.StartsWith("/") -or
        $relative.Contains([char]0) -or
        $hasUnsafeSegment
      ) {
        throw "Pinned runner archive contains an unsafe path."
      }
      if ($entry.Name.Length -eq 0) {
        continue
      }
      if (-not $seen.Add($relative)) {
        throw "Pinned runner archive contains a duplicate path."
      }
      $target = Assert-ContainedPath -Root $DestinationRoot -Path (Join-Path $DestinationRoot ($relative.Replace("/", "\")))
      [void](New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force)
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

function Get-TransientRegistrationToken {
  param([SecureString]$Token)

  if ($null -ne $Token) {
    if ($Token.Length -lt 1) {
      throw "Runner registration token must not be empty."
    }
    return [ordered]@{ token = $Token; dispose = $false }
  }
  throw "A one-time GitHub runner registration token is required. Pass -RegistrationToken as SecureString or set ACTIONS_RUNNER_REGISTRATION_TOKEN for this process only."
}

function Invoke-RunnerConfiguration {
  param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][SecureString]$Token,
    [Parameter(Mandatory)][string]$RunnerName,
    [Parameter(Mandatory)][string]$RunnerRoot
  )

  $bstr = [IntPtr]::Zero
  $plain = $null
  $arguments = $null
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $arguments = @(
      "--unattended",
      "--url", $script:CanonicalRunnerRepositoryUrl,
      "--token", $plain,
      "--name", $RunnerName,
      "--labels", "unified-ai-orchestrator",
      "--work", "_work",
      "--disableupdate"
    )
    Push-Location $RunnerRoot
    try {
      $output = & $ConfigPath @arguments 2>&1
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($exitCode -ne 0) {
      $safeOutput = (($output -join "`n").Replace($plain, "[redacted]"))
      $safeOutput = $safeOutput.Substring(0, [Math]::Min(1000, $safeOutput.Length))
      throw "GitHub runner configuration failed with exit code $exitCode`: $safeOutput"
    }
  } finally {
    $output = $null
    $arguments = $null
    $plain = $null
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Ensure-GitHubRunnerTask {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][hashtable]$Layout,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Installation,
    [Parameter(Mandatory)][string]$IdentityName,
    [Parameter(Mandatory)][string]$PowerShellPath
  )

  $taskName = [string]$Installation.taskName
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    $action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument ([string]$Installation.arguments)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $IdentityName
    $principal = New-ScheduledTaskPrincipal -UserId $IdentityName -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
      -MultipleInstances IgnoreNew `
      -Hidden
    $definition = New-ScheduledTask `
      -Action $action `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Description $script:CanonicalRunnerTaskDescription
    Register-ScheduledTask -TaskName $taskName -InputObject $definition | Out-Null
  }
  return (Assert-GitHubRunnerTaskRegistration `
      -RepositoryRoot $RepositoryRoot `
      -Layout $Layout `
      -Installation $Installation)
}

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
[void](Assert-CanonicalRunnerTaskName -TaskName $TaskName)
if ($RunnerName -cnotmatch "^[A-Za-z0-9._-]{1,64}$") {
  throw "RunnerName must contain 1-64 letters, digits, dots, underscores, or hyphens."
}
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
$startScript = Join-Path $RepositoryRoot "scripts\deployment\Start-GitHubRunner.ps1"
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
  throw "GitHub runner launcher does not exist: $startScript"
}
$powerShellPath = Get-StableExecutable -Name "pwsh.exe"
$identity = Get-CurrentWindowsIdentityReceipt
$identityName = [string]$identity.identityName
$identitySid = [string]$identity.identitySid
$runnerArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$startScript`" -RepositoryRoot `"$RepositoryRoot`""

$existingState = if (Test-Path -LiteralPath $layout.RunnerInstallation -PathType Leaf) {
  Read-GitHubRunnerInstallation -Layout $layout
} else {
  $null
}
if ($null -eq $existingState -and (Test-Path -LiteralPath $layout.RunnerRoot)) {
  throw "Runner directory exists without validated installation state; refusing to reuse or overwrite it."
}
if ($null -ne $existingState -and [bool]$existingState.configured) {
  if ([string]$existingState.runnerName -cne $RunnerName) {
    throw "The installed runner name differs from RunnerName; remove it before changing identity."
  }
  [void](Assert-PinnedRunnerBinary `
      -Layout $layout `
      -ExpectedFileCount ([int]$existingState.payloadFileCount) `
      -ExpectedTreeSha256 ([string]$existingState.payloadTreeSha256))
  $task = Ensure-GitHubRunnerTask `
    -RepositoryRoot $RepositoryRoot `
    -Layout $layout `
    -Installation $existingState `
    -IdentityName $identityName `
    -PowerShellPath $powerShellPath
  if ([string]$task.State -ne "Running" -and $PSCmdlet.ShouldProcess($TaskName, "Start already configured pinned GitHub runner task")) {
    Start-ScheduledTask -TaskName $TaskName
  }
  Write-Output "Pinned GitHub runner $RunnerName is already configured; task state is $($task.State)."
  return
}

if (-not $PSCmdlet.ShouldProcess(
    $layout.RunnerRoot,
    "Download hash-pinned official GitHub runner, register it using an in-memory one-time token, install hidden current-user task, and start it"
  )) {
  [ordered]@{
    whatIf = $true
    version = $script:PinnedRunnerVersion
    archiveUrl = $script:PinnedRunnerArchiveUrl
    archiveSha256 = $script:PinnedRunnerArchiveSha256
    runnerRoot = $layout.RunnerRoot
    repositoryUrl = $script:CanonicalRunnerRepositoryUrl
    labels = @("self-hosted", "Windows", "X64", "unified-ai-orchestrator")
    runnerName = $RunnerName
    taskName = $TaskName
    taskIdentity = $identityName
    tokenRequiredAtExecution = $true
  } | ConvertTo-Json -Depth 10
  return
}

Initialize-DeploymentLayout -Layout $layout
$archivePath = Assert-ContainedPath -Root $layout.Downloads -Path (Join-Path $layout.Downloads "actions-runner-win-x64-$($script:PinnedRunnerVersion).zip")
$extractedThisRun = $false
if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
  $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($existingHash -cne $script:PinnedRunnerArchiveSha256) {
    throw "Existing runner archive hash is invalid; refusing to overwrite it automatically."
  }
} else {
  $temporaryArchive = Assert-ContainedPath -Root $layout.Downloads -Path "$archivePath.$([guid]::NewGuid().ToString('N')).download"
  try {
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
      Invoke-WebRequest -Uri $script:PinnedRunnerArchiveUrl -OutFile $temporaryArchive -MaximumRedirection 5
    } finally {
      $ProgressPreference = $oldProgress
    }
    $actualHash = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -cne $script:PinnedRunnerArchiveSha256) {
      throw "Downloaded runner archive SHA-256 does not match the pinned official checksum."
    }
    [System.IO.File]::Move($temporaryArchive, $archivePath, $false)
  } finally {
    if (Test-Path -LiteralPath $temporaryArchive) {
      Remove-Item -LiteralPath $temporaryArchive -Force
    }
  }
}

if (-not (Test-Path -LiteralPath $layout.RunnerRoot -PathType Container)) {
  [void](New-Item -ItemType Directory -Path $layout.RunnerRoot)
  try {
    Expand-PinnedRunnerArchive -ArchivePath $archivePath -DestinationRoot $layout.RunnerRoot
    $extractedThisRun = $true
  } catch {
    [void](Assert-ContainedPath -Root $layout.Root -Path $layout.RunnerRoot)
    Remove-Item -LiteralPath $layout.RunnerRoot -Recurse -Force
    throw
  }
}
$runnerPayload = Assert-PinnedRunnerBinary -Layout $layout

$unexpectedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $unexpectedTask) {
  throw "A scheduled task named $TaskName already exists without matching installation state; refusing to configure a remote runner."
}

$aclOutput = & $script:CanonicalIcaclsPath $layout.RunnerRoot /inheritance:r /grant:r "*$($identitySid):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Unable to restrict runner directory ACL to the current user and LocalSystem: $($aclOutput -join [Environment]::NewLine)"
}

$tokenReceipt = $null
try {
  $tokenReceipt = Get-TransientRegistrationToken -Token $RegistrationToken
  Invoke-RunnerConfiguration `
    -ConfigPath (Join-Path $layout.RunnerRoot "config.cmd") `
    -Token $tokenReceipt.token `
    -RunnerName $RunnerName `
    -RunnerRoot $layout.RunnerRoot
} catch {
  if ($extractedThisRun) {
    [void](Assert-ContainedPath -Root $layout.Root -Path $layout.RunnerRoot)
    Remove-Item -LiteralPath $layout.RunnerRoot -Recurse -Force
  }
  throw
} finally {
  if ($null -ne $tokenReceipt -and [bool]$tokenReceipt.dispose) {
    $tokenReceipt.token.Dispose()
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $layout.RunnerRoot ".runner") -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $layout.RunnerRoot ".credentials") -PathType Leaf)) {
  throw "GitHub runner configuration did not create the expected local registration files."
}

$installation = [ordered]@{
  schemaVersion = 3
  version = $script:PinnedRunnerVersion
  archiveSha256 = $script:PinnedRunnerArchiveSha256
  payloadFileCount = [int]$runnerPayload.fileCount
  payloadTreeSha256 = [string]$runnerPayload.treeSha256
  repositoryUrl = $script:CanonicalRunnerRepositoryUrl
  labels = @("unified-ai-orchestrator")
  runnerName = $RunnerName
  runnerRoot = $layout.RunnerRoot
  taskName = $TaskName
  powerShellPath = $powerShellPath
  arguments = $runnerArguments
  identityName = $identityName
  identitySid = $identitySid
  configured = $true
  installedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
}
Write-AtomicJson -Layout $layout -Path $layout.RunnerInstallation -Value $installation
$task = Ensure-GitHubRunnerTask `
  -RepositoryRoot $RepositoryRoot `
  -Layout $layout `
  -Installation $installation `
  -IdentityName $identityName `
  -PowerShellPath $powerShellPath
Start-ScheduledTask -TaskName $TaskName
Write-DeploymentEvent -Layout $layout -Action "install-github-runner" -Status "succeeded" -Message "Registered and started pinned runner $RunnerName for $script:CanonicalRunnerRepositoryUrl."
Write-Output "Installed and started pinned GitHub runner $RunnerName as hidden current-user task $TaskName."
} finally {
  if ($ownedRegistrationToken -and $null -ne $RegistrationToken) {
    $RegistrationToken.Dispose()
  }
  $RegistrationToken = $null
}
