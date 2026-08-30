#requires -Version 7.4

[CmdletBinding()]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
Assert-NoDeploymentReparsePoints -Layout $layout
$installation = Read-GitHubRunnerInstallation -Layout $layout
if (-not [bool]$installation.configured) {
  throw "GitHub runner is not configured."
}
[void](Assert-GitHubRunnerTaskRegistration `
    -RepositoryRoot $RepositoryRoot `
    -Layout $layout `
    -Installation $installation)
[void](Assert-PinnedRunnerBinary `
    -Layout $layout `
    -ExpectedFileCount ([int]$installation.payloadFileCount) `
    -ExpectedTreeSha256 ([string]$installation.payloadTreeSha256))
foreach ($path in @(
    (Join-Path $layout.RunnerRoot ".runner"),
    (Join-Path $layout.RunnerRoot ".credentials")
  )) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "GitHub runner registration file is missing."
  }
}

$receipt = [ordered]@{
  schemaVersion = 1
  version = $script:PinnedRunnerVersion
  runnerName = [string]$installation.runnerName
  wrapperPid = $PID
  startedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  runnerRoot = $layout.RunnerRoot
}
Write-AtomicJson -Layout $layout -Path $layout.RunnerProcess -Value $receipt
Write-DeploymentEvent -Layout $layout -Action "start-github-runner" -Status "started" -Message "Starting pinned runner $($installation.runnerName)."
try {
  Push-Location $layout.RunnerRoot
  try {
    & (Join-Path $layout.RunnerRoot "run.cmd")
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  throw "GitHub runner exited with code $exitCode; scheduled-task restart policy may relaunch it."
} finally {
  if (Test-Path -LiteralPath $layout.RunnerProcess -PathType Leaf) {
    $current = Read-JsonHashtable -Path $layout.RunnerProcess
    if ([int]$current.wrapperPid -eq $PID) {
      Remove-Item -LiteralPath $layout.RunnerProcess -Force
    }
  }
  Write-DeploymentEvent -Layout $layout -Action "start-github-runner" -Status "info" -Message "Runner process ended; task policy decides whether to restart it."
}
