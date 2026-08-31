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
$layout = $null
$commitSha = $null
$runId = $null
$stdoutPath = $null
$stderrPath = $null
$startupDiagnosticPath = $null
$receipt = $null
$startupSucceeded = $false

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

  $preLaunchTimer = [System.Diagnostics.Stopwatch]::StartNew()
  $pointer = Read-ReleasePointer -Path $layout.Current
  $commitSha = [string]$pointer.commitSha
  $releaseRoot = Get-ReleaseRoot -Layout $layout -CommitSha $commitSha
  $runtimeReceipt = Test-SealedRuntimeDependencyAttestation `
    -Layout $layout `
    -ReleaseRoot $releaseRoot `
    -ExpectedSha $commitSha `
    -ExpectedReceiptSha256 ([string]$pointer.runtimeDependencyReceiptSha256)

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
  $entrypoint = Get-ReleaseServerEntrypoint `
    -ReleaseRoot $releaseRoot `
    -RuntimeReceipt $runtimeReceipt
  $webDistRoot = Join-Path $releaseRoot "apps\web\dist"
  foreach ($requiredPath in @((Join-Path $webDistRoot "index.html"))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Selected release is missing required runtime file $requiredPath."
    }
  }
  if ($preLaunchTimer.Elapsed.TotalSeconds -ge $HealthTimeoutSeconds) {
    throw "Bounded sealed attestation exhausted the $HealthTimeoutSeconds-second pre-launch budget."
  }

  $runId = "$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
  $runLogRoot = Assert-ContainedPath -Root $layout.Logs -Path (Join-Path $layout.Logs "$commitSha\$runId")
  [void](New-Item -ItemType Directory -Path $runLogRoot -Force)
  $stdoutPath = Join-Path $runLogRoot "stdout.log"
  $stderrPath = Join-Path $runLogRoot "stderr.log"
  $startupDiagnosticPath = Join-Path $runLogRoot "startup-diagnostic.json"

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
    if ($preLaunchTimer.Elapsed.TotalSeconds -ge $HealthTimeoutSeconds) {
      throw "Supervised startup did not reach process launch inside the $HealthTimeoutSeconds-second budget."
    }
    $child = Start-Process `
      -FilePath $nodePath `
      -ArgumentList @($entrypoint) `
      -WorkingDirectory $releaseRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
    $preLaunchTimer.Stop()
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
  Write-StartupDiagnostic `
    -Layout $layout `
    -Path $startupDiagnosticPath `
    -CommitSha $commitSha `
    -RunId $runId `
    -ProcessId $child.Id `
    -Phase "health-waiting" `
    -PreCleanupState "running" `
    -PostCleanupState "running" `
    -ExitCode $null `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Supervised ([bool]$Supervised)

  Exit-DeploymentMutex -Mutex $mutex
  $mutex = $null
  [void](Wait-ForReleaseHealth `
      -HealthUri $HealthUri `
      -ExpectedSha $commitSha `
      -TimeoutSeconds $HealthTimeoutSeconds `
      -ObservedProcess $child)
  [void](Test-ReleaseWebDocument -ReleaseRoot $releaseRoot -TimeoutSeconds 10)
  Write-StartupDiagnostic `
    -Layout $layout `
    -Path $startupDiagnosticPath `
    -CommitSha $commitSha `
    -RunId $runId `
    -ProcessId $child.Id `
    -Phase "healthy" `
    -PreCleanupState "running" `
    -PostCleanupState "running" `
    -ExitCode $null `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -Supervised ([bool]$Supervised)
  Write-DeploymentEvent -Layout $layout -Action "start" -Status "succeeded" -CommitSha $commitSha -OperationId $runId -Message "Loopback health, readiness SHA, and web document checks passed."
  $startupSucceeded = $true
  Write-Output "Started release $commitSha as PID $($child.Id); logs: $runLogRoot"

  if ($Supervised) {
    try {
      $supervision = Wait-ForSupervisedReleaseExit `
        -ObservedProcess $child `
        -ReadinessUri $HealthUri `
        -ExpectedSha $commitSha
    } catch {
      Write-DeploymentEvent `
        -Layout $layout `
        -Action "liveness" `
        -Status "failed" `
        -CommitSha $commitSha `
        -OperationId $runId `
        -Message $_.Exception.Message
      throw
    }
    $exitCode = [int]$supervision.exitCode
    Write-DeploymentEvent -Layout $layout -Action "process-exit" -Status "failed" -CommitSha $commitSha -OperationId $runId -Message "Node process exited with code $exitCode; scheduled-task restart policy may relaunch it."
    throw "Release process exited with code $exitCode."
  }
} catch {
  $failureRecord = $_
  $failureMessage = $_.Exception.Message
  $preCleanupState = if ($null -eq $child) { "not-launched" } else { "unknown" }
  $postCleanupState = $preCleanupState
  $exitCode = $null
  $childConfirmedExited = $false
  if ($null -ne $child) {
    try {
      $child.Refresh()
      $preCleanupState = if ($child.HasExited) { "exited" } else { "running" }
      if (-not $child.HasExited) {
        Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
        [void]$child.WaitForExit(10000)
        $child.Refresh()
      } else {
        [void]$child.WaitForExit()
      }
      $postCleanupState = if ($child.HasExited) { "exited" } else { "running" }
      if ($child.HasExited) {
        $exitCode = $child.ExitCode
        $childConfirmedExited = $true
      }
    } catch {
      $postCleanupState = "cleanup-observation-failed"
    }
  }
  if (-not $startupSucceeded -and
      $null -ne $layout -and
      $null -ne $startupDiagnosticPath -and
      $null -ne $commitSha -and
      $null -ne $runId -and
      $null -ne $child) {
    try {
      Write-StartupDiagnostic `
        -Layout $layout `
        -Path $startupDiagnosticPath `
        -CommitSha $commitSha `
        -RunId $runId `
        -ProcessId $child.Id `
        -Phase "failed" `
        -PreCleanupState $preCleanupState `
        -PostCleanupState $postCleanupState `
        -ExitCode $exitCode `
        -FailureMessage $failureMessage `
        -StdoutPath $stdoutPath `
        -StderrPath $stderrPath `
        -Supervised ([bool]$Supervised)
      Write-DeploymentEvent `
        -Layout $layout `
        -Action "start" `
        -Status "failed" `
        -CommitSha $commitSha `
        -OperationId $runId `
        -Message "Startup failed; child was $preCleanupState before cleanup and $postCleanupState after cleanup; exit code $exitCode; $failureMessage"
    } catch {
      Write-Warning "Startup diagnostics could not be persisted: $($_.Exception.Message)"
    }
  }
  if ($null -ne $layout -and $null -ne $receipt) {
    try {
      [void](Remove-MatchingReleaseProcessReceipt `
          -Layout $layout `
          -ExpectedReceipt $receipt `
          -ChildConfirmedExited $childConfirmedExited)
    } catch {
      Write-Warning "Failed process receipt could not be removed safely: $($_.Exception.Message)"
    }
  }
  throw $failureRecord
} finally {
  Exit-DeploymentMutex -Mutex $mutex
}
