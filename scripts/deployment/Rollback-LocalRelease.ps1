#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory)][string]$ExpectedPreviousSha,
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [string]$TaskName = "UnifiedAIOrchestrator-Local",
  [ValidateRange(1, 300)][int]$HealthTimeoutSeconds = 180
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$ExpectedPreviousSha = Assert-CommitSha -CommitSha $ExpectedPreviousSha
[void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
[void](Assert-CanonicalTaskName -TaskName $TaskName)
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
Assert-NoDeploymentReparsePoints -Layout $layout
$recoveryController = Read-LastKnownGoodRecoveryController -Layout $layout
if (-not [string]::Equals(
    [System.IO.Path]::GetFullPath($PSScriptRoot),
    [System.IO.Path]::GetFullPath([string]$recoveryController.controllerRoot),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
  throw "Rollback must run from the installed last-known-good recovery controller."
}

$transaction = Enter-DeploymentTransactionMutex
if ([bool]$transaction.WasAbandoned) {
  Assert-NoDeploymentReparsePoints -Layout $layout
  Write-DeploymentEvent -Layout $layout -Action "lock-recovery" -Status "info" -Message "Recovered an abandoned deployment transaction mutex after revalidating deployment paths."
}
$operationId = Get-OperationId
$current = $null
$currentSha = $null
$targetSha = $ExpectedPreviousSha
$activationStarted = $false
$activationCommitted = $false
$pendingWritten = $false
try {
  $lockedRecoveryController = Read-LastKnownGoodRecoveryController -Layout $layout
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath($PSScriptRoot),
      [System.IO.Path]::GetFullPath([string]$lockedRecoveryController.controllerRoot),
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$lockedRecoveryController.controllerVersion -cne [string]$recoveryController.controllerVersion -or
    [string]$lockedRecoveryController.controllerManifestSha256 -cne [string]$recoveryController.controllerManifestSha256) {
    throw "Last-known-good recovery controller authority changed while rollback waited for the deployment lock."
  }
  $recoveryController = $lockedRecoveryController
  [void](Recover-InterruptedDeploymentActivation `
      -Layout $layout `
      -RepositoryRoot $RepositoryRoot `
      -TaskName $TaskName `
      -HealthUri $HealthUri `
      -HealthTimeoutSeconds $HealthTimeoutSeconds)
  [void](Recover-InterruptedReleaseInstallation -Layout $layout)
  $lockedRecoveryController = Read-LastKnownGoodRecoveryController -Layout $layout
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath($PSScriptRoot),
      [System.IO.Path]::GetFullPath([string]$lockedRecoveryController.controllerRoot),
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$lockedRecoveryController.controllerVersion -cne [string]$recoveryController.controllerVersion -or
    [string]$lockedRecoveryController.controllerManifestSha256 -cne [string]$recoveryController.controllerManifestSha256) {
    throw "Last-known-good recovery controller authority changed while rollback waited for the deployment lock."
  }
  $recoveryController = $lockedRecoveryController
  Assert-NoForeignDeploymentPendingRecords -Layout $layout
  # Re-read and compare the pointer after taking the cross-session lock. The
  # workflow's earlier confirmation is useful operator context, not authority.
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  $current = Read-ReleasePointer -Path $layout.Current
  $previous = Read-ReleasePointer -Path $layout.Previous
  $currentSha = [string]$current.commitSha
  $targetSha = [string]$previous.commitSha
  if ($targetSha -cne $ExpectedPreviousSha) {
    throw "Previous pointer $targetSha changed after confirmation; expected $ExpectedPreviousSha."
  }
  if ($currentSha -ceq $targetSha) {
    throw "Rollback target is identical to the current release."
  }
  $targetRoot = Get-ReleaseRoot -Layout $layout -CommitSha $targetSha
  $targetRuntimeReceipt = Test-SealedRuntimeDependencyAttestation `
    -Layout $layout `
    -ReleaseRoot $targetRoot `
    -ExpectedSha $targetSha `
    -ExpectedReceiptSha256 ([string]$previous.runtimeDependencyReceiptSha256)
  if (Test-Path -LiteralPath $layout.Pending -PathType Leaf) {
    throw "An unresolved pending deployment record exists; inspect and recover it before rollback."
  }

  if (-not $PSCmdlet.ShouldProcess(
      "$currentSha -> $targetSha",
      "Rollback binary and web release pointer, restart supervised task, and require health"
    )) {
    [ordered]@{
      whatIf = $true
      currentSha = $currentSha
      rollbackTargetSha = $targetSha
      targetRoot = $targetRoot
    } | ConvertTo-Json -Depth 10
    return
  }

  $backupRoot = Backup-DeploymentState -Layout $layout -OperationId $operationId
  $backupManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $backupRoot "backup.json") -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-AtomicJson -Layout $layout -Path $layout.Pending -Value ([ordered]@{
      schemaVersion = 2
      action = "rollback"
      commitSha = $targetSha
      operationId = $operationId
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
      state = "rolling-back"
      backupRoot = $backupRoot
      backupManifestSha256 = $backupManifestSha256
    })
  $pendingWritten = $true
  Write-DeploymentEvent -Layout $layout -Action "rollback" -Status "started" -CommitSha $targetSha -OperationId $operationId -Message "Rolling back deployed binaries and web bundle; canonical Git checkout is unchanged."
  $activationStarted = $true
  & (Join-Path $PSScriptRoot "Stop-LocalRelease.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -TaskName $TaskName `
    -Confirm:$false
  Write-AtomicJson -Layout $layout -Path $layout.Current -Value (New-ReleasePointer `
      -CommitSha $targetSha `
      -Reason "rollback:$operationId" `
      -RuntimeDependencyReceiptSha256 ([string]$targetRuntimeReceipt.runtimeIntegritySha256))
  Start-ScheduledTask -TaskName $TaskName
  [void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha $targetSha -TimeoutSeconds $HealthTimeoutSeconds)
  [void](Test-ReleaseWebDocument -ReleaseRoot $targetRoot -TimeoutSeconds 10)
  $live = Get-LiveReleaseProcess -Layout $layout -ExpectedSha $targetSha
  if ($null -eq $live) {
    throw "Rollback health passed but no exact rollback process receipt is live."
  }
  Write-AtomicJson -Layout $layout -Path $layout.Previous -Value $current
  $recoveryController = Set-LastKnownGoodRecoveryController `
    -Layout $layout `
    -RepositoryRoot $RepositoryRoot `
    -QualifiedReleaseSha $targetSha `
    -TaskName $TaskName
  $releaseAcceptanceOutput = & (Join-Path $PSScriptRoot "Test-LocalRelease.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -ExpectedSha $targetSha `
    -HealthUri $HealthUri `
    -HealthTimeoutSeconds $HealthTimeoutSeconds `
    -TaskName $TaskName
  $releaseAcceptance = ($releaseAcceptanceOutput -join "`n") | ConvertFrom-Json -AsHashtable
  if (-not [bool]$releaseAcceptance.accepted -or [string]$releaseAcceptance.commitSha -cne $targetSha) {
    throw "Rollback release acceptance did not attest the target exact SHA."
  }
  $aiAcceptanceOutput = & (Join-Path $PSScriptRoot "Test-LocalAiRuntime.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -TimeoutSeconds $HealthTimeoutSeconds
  $aiAcceptance = ($aiAcceptanceOutput -join "`n") | ConvertFrom-Json -AsHashtable
  if (-not [bool]$aiAcceptance.accepted -or
      [string]$aiAcceptance.model -cne "qwen3:4b" -or
      [string]$aiAcceptance.ollamaPhase -cne "ready" -or
      [string]$aiAcceptance.whiteShadowPhase -cne "ready") {
    throw "Full rollback local-AI acceptance did not attest both governed backends."
  }
  Remove-Item -LiteralPath $layout.Pending -Force
  $pendingWritten = $false
  $activationCommitted = $true
  try {
    Write-DeploymentEvent -Layout $layout -Action "rollback" -Status "succeeded" -CommitSha $targetSha -OperationId $operationId -Message "Rollback health, readiness SHA, and web document passed."
  } catch {
    Write-Warning "Rollback committed but success-event logging failed: $($_.Exception.Message)"
  }
  [ordered]@{
    rolledBack = $true
    commitSha = $targetSha
    previousSha = $currentSha
    processId = [int]$live.receipt.pid
    operationId = $operationId
    recoveryControllerVersion = [string]$recoveryController.controllerVersion
    localReleaseAccepted = [bool]$releaseAcceptance.accepted
    ollamaPhase = [string]$aiAcceptance.ollamaPhase
    whiteShadowPhase = [string]$aiAcceptance.whiteShadowPhase
  } | ConvertTo-Json -Depth 10
} catch {
  $failure = $_.Exception.Message
  try {
    Write-DeploymentEvent -Layout $layout -Action "rollback" -Status "failed" -CommitSha $targetSha -OperationId $operationId -Message $failure
  } catch {
    $failure = "$failure Rollback failure logging also failed."
  }
  $recoverySucceeded = -not $activationStarted
  if ($activationStarted -and -not $activationCommitted -and $null -ne $current -and $null -ne $currentSha) {
    try {
      [void](Recover-InterruptedDeploymentActivation `
          -Layout $layout `
          -RepositoryRoot $RepositoryRoot `
          -TaskName $TaskName `
          -HealthUri $HealthUri `
          -HealthTimeoutSeconds $HealthTimeoutSeconds)
      $recoverySucceeded = $true
    } catch {
      $failure = "$failure Restore-current also failed: $($_.Exception.Message)"
    }
  }
  if ($pendingWritten -and $recoverySucceeded -and (Test-Path -LiteralPath $layout.Pending -PathType Leaf)) {
    Remove-Item -LiteralPath $layout.Pending -Force
  }
  throw $failure
} finally {
  Exit-DeploymentMutex -Mutex $transaction
}
