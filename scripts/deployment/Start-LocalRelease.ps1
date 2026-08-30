#requires -Version 7.4

[CmdletBinding()]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [switch]$Supervised,
  [ValidateRange(1, 300)][int]$HealthTimeoutSeconds = 180
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$mutex = $null
$child = $null
try {
  $RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
  [void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
  $layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
  Assert-NoDeploymentReparsePoints -Layout $layout
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $script:CanonicalTaskName)
  if ($Supervised) {
    $taskInstallation = Read-DeploymentTaskInstallation -Layout $layout
    if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath($PSCommandPath),
        [System.IO.Path]::GetFullPath([string]$taskInstallation.startScript),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Supervised startup must run from the installed immutable recovery controller."
    }
  }
  $mutex = Enter-DeploymentMutex
  if ([bool]$mutex.WasAbandoned) {
    Assert-NoDeploymentReparsePoints -Layout $layout
    Write-DeploymentEvent -Layout $layout -Action "lock-recovery" -Status "info" -Message "Recovered an abandoned deployment-state mutex after revalidating deployment paths."
  }

  $pointer = Read-ReleasePointer -Path $layout.Current
  $commitSha = [string]$pointer.commitSha
  $releaseRoot = Get-ReleaseRoot -Layout $layout -CommitSha $commitSha
  [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $releaseRoot -ExpectedSha $commitSha)
  $runtimeReceipt = Test-RuntimeDependencyIntegrity `
    -Layout $layout `
    -ReleaseRoot $releaseRoot `
    -ExpectedSha $commitSha `
    -ExpectedReceiptSha256 ([string]$pointer.runtimeDependencyReceiptSha256)
  [void](Assert-ReleaseDirectoryProtection -Layout $layout -ReleaseRoot $releaseRoot -IdentitySid ([string]$runtimeReceipt.identitySid))

  $existing = Get-LiveReleaseProcess -Layout $layout -ExpectedSha $commitSha
  if ($null -ne $existing) {
    [void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha $commitSha -TimeoutSeconds 5)
    Write-Output "Release $commitSha is already running as PID $($existing.receipt.pid)."
    return
  }
  if (Test-Path -LiteralPath $layout.Process -PathType Leaf) {
    Remove-Item -LiteralPath $layout.Process -Force
  }

  $nodePath = [string]$runtimeReceipt.nodePath
  $nodeVersion = Assert-NodeRuntime -NodePath $nodePath
  $entrypoint = Join-Path $releaseRoot "apps\api\dist\server.js"
  $webDistRoot = Join-Path $releaseRoot "apps\web\dist"
  foreach ($requiredPath in @($entrypoint, (Join-Path $webDistRoot "index.html"))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Selected release is missing required runtime file $requiredPath."
    }
  }

  $runId = "$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
  $runLogRoot = Assert-ContainedPath -Root $layout.Logs -Path (Join-Path $layout.Logs "$commitSha\$runId")
  [void](New-Item -ItemType Directory -Path $runLogRoot -Force)
  $stdoutPath = Join-Path $runLogRoot "stdout.log"
  $stderrPath = Join-Path $runLogRoot "stderr.log"

  $previousEnvironment = [ordered]@{}
  $runtimeEnvironment = [ordered]@{
    NODE_ENV = "production"
    ORCHESTRATOR_HOST = "127.0.0.1"
    ORCHESTRATOR_PORT = "8790"
    ORCHESTRATOR_RELEASE_SHA = $commitSha
    ORCHESTRATOR_WEB_DIST_ROOT = $webDistRoot
  }
  foreach ($name in $runtimeEnvironment.Keys) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, [string]$runtimeEnvironment[$name], "Process")
  }
  try {
    $child = Start-Process `
      -FilePath $nodePath `
      -ArgumentList @($entrypoint) `
      -WorkingDirectory $releaseRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    foreach ($name in $previousEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
  }

  $receipt = [ordered]@{
    schemaVersion = 2
    commitSha = $commitSha
    pid = $child.Id
    entrypoint = $entrypoint
    nodePath = $nodePath
    nodeVersion = $nodeVersion
    nodeSha256 = [string]$runtimeReceipt.nodeSha256
    runtimeDependencyReceiptSha256 = [string]$runtimeReceipt.runtimeIntegritySha256
    startedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    supervised = [bool]$Supervised
  }
  Write-AtomicJson -Layout $layout -Path $layout.Process -Value $receipt
  Write-DeploymentEvent -Layout $layout -Action "start" -Status "started" -CommitSha $commitSha -OperationId $runId -Message "Node process $($child.Id) launched."

  Exit-DeploymentMutex -Mutex $mutex
  $mutex = $null
  [void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha $commitSha -TimeoutSeconds $HealthTimeoutSeconds)
  [void](Test-ReleaseWebDocument -ReleaseRoot $releaseRoot -TimeoutSeconds 10)
  Write-DeploymentEvent -Layout $layout -Action "start" -Status "succeeded" -CommitSha $commitSha -OperationId $runId -Message "Loopback health, readiness SHA, and web document checks passed."
  Write-Output "Started release $commitSha as PID $($child.Id); logs: $runLogRoot"

  if ($Supervised) {
    $child.WaitForExit()
    $exitCode = $child.ExitCode
    $currentReceipt = if (Test-Path -LiteralPath $layout.Process -PathType Leaf) {
      Read-JsonHashtable -Path $layout.Process
    } else {
      $null
    }
    if ($null -ne $currentReceipt -and [int]$currentReceipt.pid -eq $child.Id) {
      Remove-Item -LiteralPath $layout.Process -Force
    }
    Write-DeploymentEvent -Layout $layout -Action "process-exit" -Status "failed" -CommitSha $commitSha -OperationId $runId -Message "Node process exited with code $exitCode; scheduled-task restart policy may relaunch it."
    throw "Release process exited with code $exitCode."
  }
} catch {
  if ($null -ne $child -and -not $child.HasExited) {
    Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  Exit-DeploymentMutex -Mutex $mutex
}
