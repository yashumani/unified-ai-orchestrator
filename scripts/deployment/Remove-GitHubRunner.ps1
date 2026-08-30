#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [SecureString]$RemovalToken,
  [string]$TaskName = "UnifiedAIOrchestrator-GitHubRunner"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$ownedRemovalToken = $false
$removalTokenFromEnvironment = [Environment]::GetEnvironmentVariable("ACTIONS_RUNNER_REMOVAL_TOKEN", "Process")
[Environment]::SetEnvironmentVariable("ACTIONS_RUNNER_REMOVAL_TOKEN", $null, "Process")
if ($null -ne $RemovalToken -and -not [string]::IsNullOrWhiteSpace($removalTokenFromEnvironment)) {
  $removalTokenFromEnvironment = $null
  throw "Supply the runner removal token through either SecureString or ACTIONS_RUNNER_REMOVAL_TOKEN, not both."
}
if ($null -eq $RemovalToken -and -not [string]::IsNullOrWhiteSpace($removalTokenFromEnvironment)) {
  try {
    $RemovalToken = ConvertTo-SecureString -String $removalTokenFromEnvironment -AsPlainText -Force
    $ownedRemovalToken = $true
  } finally {
    $removalTokenFromEnvironment = $null
  }
}
$removalTokenFromEnvironment = $null

try {
function Get-TransientRemovalToken {
  param([SecureString]$Token)

  if ($null -ne $Token) {
    if ($Token.Length -lt 1) {
      throw "Runner removal token must not be empty."
    }
    return [ordered]@{ token = $Token; dispose = $false }
  }
  throw "A one-time GitHub runner removal token is required. Pass -RemovalToken as SecureString or set ACTIONS_RUNNER_REMOVAL_TOKEN for this process only."
}

function Invoke-RunnerRemoval {
  param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][SecureString]$Token,
    [Parameter(Mandatory)][string]$RunnerRoot
  )

  $bstr = [IntPtr]::Zero
  $plain = $null
  $arguments = $null
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $arguments = @("remove", "--token", $plain)
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
      throw "GitHub runner removal failed with exit code $exitCode`: $safeOutput"
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

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
[void](Assert-CanonicalRunnerTaskName -TaskName $TaskName)
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
if (-not (Test-Path -LiteralPath $layout.RunnerInstallation -PathType Leaf)) {
  if ($null -eq (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Output "Pinned GitHub runner is already absent."
    return
  }
  throw "Runner task exists without validated installation state; refusing to remove it."
}
$installation = Read-GitHubRunnerInstallation -Layout $layout
if (-not [bool]$installation.configured -and -not (Test-Path -LiteralPath (Join-Path $layout.RunnerRoot ".runner"))) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Output "Pinned GitHub runner is already unregistered and its task is absent."
    return
  }
  [void](Assert-GitHubRunnerTaskRegistration -RepositoryRoot $RepositoryRoot -Layout $layout -Installation $installation)
  if ($PSCmdlet.ShouldProcess($TaskName, "Remove stale exact runner task")) {
    if ([string]$task.State -eq "Running") {
      Stop-ScheduledTask -TaskName $TaskName
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Write-Output "Pinned GitHub runner was already unregistered; stale task removal is complete."
  return
}
$task = Assert-GitHubRunnerTaskRegistration -RepositoryRoot $RepositoryRoot -Layout $layout -Installation $installation
[void](Assert-PinnedRunnerBinary -Layout $layout)

if (-not $PSCmdlet.ShouldProcess(
    [string]$installation.runnerName,
    "Stop hidden task, unregister exact repository runner using one-time in-memory token, and preserve local files"
  )) {
  [ordered]@{
    whatIf = $true
    runnerName = [string]$installation.runnerName
    repositoryUrl = [string]$installation.repositoryUrl
    taskName = $TaskName
    runnerRoot = $layout.RunnerRoot
    removalTokenRequiredAtExecution = $true
    localFilesPreserved = $true
  } | ConvertTo-Json -Depth 10
  return
}

if ([string]$task.State -eq "Running") {
  Stop-ScheduledTask -TaskName $TaskName
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $task = Get-ScheduledTask -TaskName $TaskName
  } while ([string]$task.State -eq "Running" -and [DateTimeOffset]::UtcNow -lt $deadline)
  if ([string]$task.State -eq "Running") {
    throw "GitHub runner scheduled task did not stop within 15 seconds."
  }
}

$tokenReceipt = $null
try {
  $tokenReceipt = Get-TransientRemovalToken -Token $RemovalToken
  Invoke-RunnerRemoval `
    -ConfigPath (Join-Path $layout.RunnerRoot "config.cmd") `
    -Token $tokenReceipt.token `
    -RunnerRoot $layout.RunnerRoot
} catch {
  try {
    Start-ScheduledTask -TaskName $TaskName
  } catch {
    Write-Warning "Runner removal failed and its task could not be restarted."
  }
  throw
} finally {
  if ($null -ne $tokenReceipt -and [bool]$tokenReceipt.dispose) {
    $tokenReceipt.token.Dispose()
  }
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
$installation.configured = $false
$installation.removedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
Write-AtomicJson -Layout $layout -Path $layout.RunnerInstallation -Value $installation
if (Test-Path -LiteralPath $layout.RunnerProcess -PathType Leaf) {
  Remove-Item -LiteralPath $layout.RunnerProcess -Force
}
Write-DeploymentEvent -Layout $layout -Action "remove-github-runner" -Status "succeeded" -Message "Unregistered pinned runner $($installation.runnerName); local files were preserved."
Write-Output "Unregistered GitHub runner $($installation.runnerName) and removed its task. Pinned binaries, work files, logs, app releases, evidence, and secrets were not deleted."
} finally {
  if ($ownedRemovalToken -and $null -ne $RemovalToken) {
    $RemovalToken.Dispose()
  }
  $RemovalToken = $null
}
