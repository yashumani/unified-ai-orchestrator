#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory)][string]$ArtifactPath,
  [Parameter(Mandatory)][string]$ExpectedSha,
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [string]$TaskName = "UnifiedAIOrchestrator-Local",
  [ValidateRange(1, 300)][int]$HealthTimeoutSeconds = 180
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$ExpectedSha = Assert-CommitSha -CommitSha $ExpectedSha
[void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
[void](Assert-CanonicalTaskName -TaskName $TaskName)
$ArtifactPath = [System.IO.Path]::GetFullPath($ArtifactPath)
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
$sourceReceipt = Assert-DeploymentSource -RepositoryRoot $RepositoryRoot -ExpectedSha $ExpectedSha
$manifest = Test-ReleaseArchive -ArtifactPath $ArtifactPath -ExpectedSha $ExpectedSha
$task = Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName
$releaseRoot = Get-ReleaseRoot -Layout $layout -CommitSha $ExpectedSha

if (-not $PSCmdlet.ShouldProcess(
    $releaseRoot,
    "Install immutable release, activate pointer, restart supervised task, and require post-deploy health"
  )) {
  [ordered]@{
    whatIf = $true
    artifactPath = $ArtifactPath
    expectedSha = $ExpectedSha
    canonicalHead = $sourceReceipt.head
    branch = $sourceReceipt.branch
    taskName = $TaskName
    releaseRoot = $releaseRoot
    nodeRuntimeRoot = $layout.NodeRuntimeRoot
    payloadFiles = $manifest.payloadSha256.Count
  } | ConvertTo-Json -Depth 10
  return
}

Initialize-DeploymentLayout -Layout $layout
$transaction = Enter-DeploymentTransactionMutex
if ([bool]$transaction.WasAbandoned) {
  Assert-NoDeploymentReparsePoints -Layout $layout
  Write-DeploymentEvent -Layout $layout -Action "lock-recovery" -Status "info" -Message "Recovered an abandoned deployment transaction mutex after revalidating deployment paths."
}
$operationId = Get-OperationId
$stagingRoot = Assert-ContainedPath -Root $layout.Staging -Path (Join-Path $layout.Staging "$ExpectedSha-$operationId")
$oldPointer = $null
$activationStarted = $false
$activationCommitted = $false
$pendingWritten = $false
$releaseInstallPendingWritten = $false
try {
  [void](Assert-DeploymentSource -RepositoryRoot $RepositoryRoot -ExpectedSha $ExpectedSha)
  [void](Recover-InterruptedDeploymentActivation `
      -Layout $layout `
      -RepositoryRoot $RepositoryRoot `
      -TaskName $TaskName `
      -HealthUri $HealthUri `
      -HealthTimeoutSeconds $HealthTimeoutSeconds)
  [void](Recover-InterruptedReleaseInstallation -Layout $layout)
  Assert-NoForeignDeploymentPendingRecords -Layout $layout
  # Repeat every drift-prone preflight after acquiring the cross-session lock.
  [void](Assert-DeploymentSource -RepositoryRoot $RepositoryRoot -ExpectedSha $ExpectedSha)
  [void](Test-ReleaseArchive -ArtifactPath $ArtifactPath -ExpectedSha $ExpectedSha)
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  $nodeRuntime = Read-PinnedNodeRuntimeAttestation -Layout $layout
  Write-DeploymentEvent -Layout $layout -Action "deploy" -Status "started" -CommitSha $ExpectedSha -OperationId $operationId -Message "Validated exact-SHA release artifact and canonical main source."

  if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
    $runtimeReceipt = Test-SealedRuntimeDependencyAttestation `
      -Layout $layout `
      -ReleaseRoot $releaseRoot `
      -ExpectedSha $ExpectedSha
  } else {
    Write-AtomicJson -Layout $layout -Path $layout.ReleaseInstallationPending -Value ([ordered]@{
        schemaVersion = 1
        commitSha = $ExpectedSha
        operationId = $operationId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        state = "installing"
        artifactSha256 = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
        releaseRoot = $releaseRoot
        stagingRoot = $stagingRoot
      })
    $releaseInstallPendingWritten = $true
    [void](New-Item -ItemType Directory -Path $stagingRoot)
    try {
      Expand-ValidatedReleaseArchive -ArtifactPath $ArtifactPath -DestinationRoot $stagingRoot
      [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $stagingRoot -ExpectedSha $ExpectedSha)
      Move-Item -LiteralPath $stagingRoot -Destination $releaseRoot
      $nodePath = [string]$nodeRuntime.nodePath
      [void](Read-BundledRuntimeBuildReceipt -ReleaseRoot $releaseRoot)
      [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $releaseRoot -ExpectedSha $ExpectedSha)
      $runtimeReceipt = Write-SealedRuntimeDependencyAttestation `
        -Layout $layout `
        -ReleaseRoot $releaseRoot `
        -ExpectedSha $ExpectedSha `
        -NodePath $nodePath
      Remove-Item -LiteralPath $layout.ReleaseInstallationPending -Force
      $releaseInstallPendingWritten = $false
    } finally {
      if (Test-Path -LiteralPath $stagingRoot) {
        [void](Assert-ContainedPath -Root $layout.Staging -Path $stagingRoot)
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
      }
    }
  }

  if (Test-Path -LiteralPath $layout.Current -PathType Leaf) {
    $oldPointer = Read-ReleasePointer -Path $layout.Current
    $oldReleaseRoot = Get-ReleaseRoot -Layout $layout -CommitSha ([string]$oldPointer.commitSha)
    $oldRuntimeReceipt = Test-SealedRuntimeDependencyAttestation `
      -Layout $layout `
      -ReleaseRoot $oldReleaseRoot `
      -ExpectedSha ([string]$oldPointer.commitSha) `
      -ExpectedReceiptSha256 ([string]$oldPointer.runtimeDependencyReceiptSha256)
  }
  if (Test-Path -LiteralPath $layout.Pending -PathType Leaf) {
    throw "An unresolved pending deployment record exists; inspect and recover it before another activation."
  }
  $backupRoot = Backup-DeploymentState -Layout $layout -OperationId $operationId
  $backupManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $backupRoot "backup.json") -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-AtomicJson -Layout $layout -Path $layout.Pending -Value ([ordered]@{
      schemaVersion = 2
      action = "deploy"
      commitSha = $ExpectedSha
      operationId = $operationId
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
      state = "activating"
      backupRoot = $backupRoot
      backupManifestSha256 = $backupManifestSha256
    })
  $pendingWritten = $true

  $activationStarted = $true
  & (Join-Path $PSScriptRoot "Stop-LocalRelease.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -TaskName $TaskName `
    -Confirm:$false
  Write-AtomicJson -Layout $layout -Path $layout.Current -Value (New-ReleasePointer `
      -CommitSha $ExpectedSha `
      -Reason "deploy:$operationId" `
      -RuntimeDependencyReceiptSha256 ([string]$runtimeReceipt.runtimeIntegritySha256))
  Start-ScheduledTask -TaskName $TaskName
  [void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha $ExpectedSha -TimeoutSeconds $HealthTimeoutSeconds)
  [void](Test-ReleaseWebDocument -ReleaseRoot $releaseRoot -TimeoutSeconds 10)
  $live = Get-LiveReleaseProcess -Layout $layout -ExpectedSha $ExpectedSha
  if ($null -eq $live) {
    throw "Post-deploy health passed but no exact process receipt is live."
  }

  if ($null -ne $oldPointer -and [string]$oldPointer.commitSha -cne $ExpectedSha) {
    Write-AtomicJson -Layout $layout -Path $layout.Previous -Value $oldPointer
  }
  $recoveryController = Set-LastKnownGoodRecoveryController `
    -Layout $layout `
    -RepositoryRoot $RepositoryRoot `
    -QualifiedReleaseSha $ExpectedSha `
    -TaskName $TaskName
  $controllerRoot = [string]$recoveryController.controllerRoot
  $releaseAcceptanceOutput = & (Join-Path $controllerRoot "Test-LocalRelease.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -ExpectedSha $ExpectedSha `
    -RequireRepositoryHeadMatch `
    -HealthUri $HealthUri `
    -HealthTimeoutSeconds $HealthTimeoutSeconds `
    -TaskName $TaskName
  $releaseAcceptance = ($releaseAcceptanceOutput -join "`n") | ConvertFrom-Json -AsHashtable
  if (-not [bool]$releaseAcceptance.accepted -or [string]$releaseAcceptance.commitSha -cne $ExpectedSha) {
    throw "Local-release acceptance did not attest the activated exact SHA."
  }
  $aiAcceptanceOutput = & (Join-Path $controllerRoot "Test-LocalAiRuntime.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -TimeoutSeconds $HealthTimeoutSeconds
  $aiAcceptance = ($aiAcceptanceOutput -join "`n") | ConvertFrom-Json -AsHashtable
  if (-not [bool]$aiAcceptance.accepted -or
      [string]$aiAcceptance.model -cne "qwen3:4b" -or
      [string]$aiAcceptance.ollamaPhase -cne "ready" -or
      [string]$aiAcceptance.whiteShadowPhase -cne "ready") {
    throw "Full local-AI acceptance did not attest both governed backends."
  }
  if (Test-Path -LiteralPath $layout.Pending -PathType Leaf) {
    Remove-Item -LiteralPath $layout.Pending -Force
  }
  $activationCommitted = $true
  try {
    Write-DeploymentEvent -Layout $layout -Action "deploy" -Status "succeeded" -CommitSha $ExpectedSha -OperationId $operationId -Message "Exact release process, readiness SHA, evidence readiness, and web document passed."
  } catch {
    Write-Warning "Deployment committed but success-event logging failed: $($_.Exception.Message)"
  }
  [ordered]@{
    deployed = $true
    commitSha = $ExpectedSha
    releaseRoot = $releaseRoot
    processId = [int]$live.receipt.pid
    taskName = $TaskName
    healthUri = $HealthUri
    readinessUri = $script:CanonicalReadyUri
    previousSha = if ($null -eq $oldPointer) { $null } else { [string]$oldPointer.commitSha }
    recoveryControllerVersion = [string]$recoveryController.controllerVersion
    recoveryControllerManifestSha256 = [string]$recoveryController.controllerManifestSha256
    localReleaseAccepted = [bool]$releaseAcceptance.accepted
    ollamaPhase = [string]$aiAcceptance.ollamaPhase
    whiteShadowPhase = [string]$aiAcceptance.whiteShadowPhase
    operationId = $operationId
  } | ConvertTo-Json -Depth 10
} catch {
  $failure = $_.Exception.Message
  if ($releaseInstallPendingWritten -or (Test-Path -LiteralPath $layout.ReleaseInstallationPending -PathType Leaf)) {
    try {
      $installRecovery = Recover-InterruptedReleaseInstallation -Layout $layout
      $failure = "$failure Interrupted release installation recovery completed for $([string]$installRecovery.commitSha)."
    } catch {
      $failure = "$failure Incomplete-release quarantine also failed: $($_.Exception.Message)"
    }
  }
  try {
    Write-DeploymentEvent -Layout $layout -Action "deploy" -Status "failed" -CommitSha $ExpectedSha -OperationId $operationId -Message $failure
  } catch {
    $failure = "$failure Deployment failure logging also failed."
  }
  $recoverySucceeded = -not $activationStarted
  if ($activationStarted -and -not $activationCommitted) {
    try {
      [void](Recover-InterruptedDeploymentActivation `
          -Layout $layout `
          -RepositoryRoot $RepositoryRoot `
          -TaskName $TaskName `
          -HealthUri $HealthUri `
          -HealthTimeoutSeconds $HealthTimeoutSeconds)
      $recoverySucceeded = $true
    } catch {
      $failure = "$failure Rollback-on-failure also failed: $($_.Exception.Message)"
    }
  }
  if ($pendingWritten -and $recoverySucceeded -and (Test-Path -LiteralPath $layout.Pending -PathType Leaf)) {
    Remove-Item -LiteralPath $layout.Pending -Force
  }
  throw $failure
} finally {
  Exit-DeploymentMutex -Mutex $transaction
}
