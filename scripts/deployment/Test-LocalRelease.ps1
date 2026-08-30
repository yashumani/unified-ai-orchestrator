#requires -Version 7.4

[CmdletBinding()]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$ExpectedSha,
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [switch]$RequireRepositoryHeadMatch,
  [switch]$FullAudit,
  [string]$ExpectedFullAuditTreeSha256,
  [ValidateRange(1, 300)][int]$HealthTimeoutSeconds = 180,
  [ValidateRange(1, 7200)][int]$IntegrityTimeoutSeconds = 180,
  [string]$TaskName = "UnifiedAIOrchestrator-Local"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
[void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
[void](Assert-CanonicalTaskName -TaskName $TaskName)
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
Assert-NoDeploymentReparsePoints -Layout $layout
$pointer = Read-ReleasePointer -Path $layout.Current
$selectedSha = [string]$pointer.commitSha
if ([string]::IsNullOrWhiteSpace($ExpectedSha)) {
  $ExpectedSha = $selectedSha
} else {
  [void](Assert-CommitSha -CommitSha $ExpectedSha)
}
if ($selectedSha -cne $ExpectedSha) {
  throw "Current release pointer $selectedSha does not match ExpectedSha $ExpectedSha."
}
if ($RequireRepositoryHeadMatch) {
  [void](Assert-DeploymentSource -RepositoryRoot $RepositoryRoot -ExpectedSha $ExpectedSha)
}

$releaseRoot = Get-ReleaseRoot -Layout $layout -CommitSha $ExpectedSha
$runtimeTimer = [System.Diagnostics.Stopwatch]::StartNew()
$runtimeReceipt = if ($FullAudit) {
  Test-RuntimeDependencyIntegrityFullAudit `
    -Layout $layout `
    -ReleaseRoot $releaseRoot `
    -ExpectedSha $ExpectedSha `
    -ExpectedReceiptSha256 ([string]$pointer.runtimeDependencyReceiptSha256) `
    -ExpectedTreeSha256 $ExpectedFullAuditTreeSha256
} else {
  Test-SealedRuntimeDependencyAttestation `
    -Layout $layout `
    -ReleaseRoot $releaseRoot `
    -ExpectedSha $ExpectedSha `
    -ExpectedReceiptSha256 ([string]$pointer.runtimeDependencyReceiptSha256)
}
$runtimeTimer.Stop()
if ($runtimeTimer.Elapsed.TotalSeconds -gt $IntegrityTimeoutSeconds) {
  throw "Release attestation exceeded the $IntegrityTimeoutSeconds-second qualification budget."
}
$live = Get-LiveReleaseProcess -Layout $layout -ExpectedSha $ExpectedSha
if ($null -eq $live) {
  throw "No live process matches the selected release SHA."
}
$task = Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName
if ([string]$task.State -ne "Running") {
  throw "Scheduled task $TaskName is not supervising the release; state is $($task.State)."
}
[void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha $ExpectedSha -TimeoutSeconds $HealthTimeoutSeconds)
$webIndexSha256 = Test-ReleaseWebDocument -ReleaseRoot $releaseRoot -TimeoutSeconds 10
$recoveryController = Read-LastKnownGoodRecoveryController -Layout $layout
if ([string]$recoveryController.qualifiedReleaseSha -cne $ExpectedSha) {
  throw "Last-known-good recovery controller is not qualified for the selected release."
}

$result = [ordered]@{
  accepted = $true
  commitSha = $ExpectedSha
  pointerPath = $layout.Current
  releaseRoot = $releaseRoot
  processId = [int]$live.receipt.pid
  taskName = $TaskName
  taskState = [string]$task.State
  healthUri = $HealthUri
  readinessUri = $script:CanonicalReadyUri
  webIndexSha256 = $webIndexSha256
  packageLockSha256 = [string]$runtimeReceipt.packageLockSha256
  runtimeAttestationKind = [string]$runtimeReceipt.attestationKind
  runtimeAttestationMode = [string]$runtimeReceipt.attestationMode
  runtimeAttestationMilliseconds = [int64]$runtimeTimer.ElapsedMilliseconds
  runtimeCriticalPathCount = [int]$runtimeReceipt.criticalPathCount
  dependencyGraphSha256 = if ($runtimeReceipt.Contains("dependencyGraphSha256")) {
    [string]$runtimeReceipt.dependencyGraphSha256
  } else { $null }
  dependencyGraphNodeCount = if ($runtimeReceipt.Contains("dependencyGraphNodeCount")) {
    [int]$runtimeReceipt.dependencyGraphNodeCount
  } else { $null }
  fullAuditTreeSha256 = if ($runtimeReceipt.Contains("fullAuditTreeSha256")) {
    [string]$runtimeReceipt.fullAuditTreeSha256
  } else { $null }
  fullAuditFileCount = if ($runtimeReceipt.Contains("fullAuditFileCount")) {
    [int]$runtimeReceipt.fullAuditFileCount
  } else { $null }
  runtimeLinkCount = if ($runtimeReceipt.Contains("workspaceLinkCount")) {
    [int]$runtimeReceipt.workspaceLinkCount
  } elseif ($runtimeReceipt.Contains("linkCount")) {
    [int]$runtimeReceipt.linkCount
  } else { $null }
  integrityBudgetSeconds = $IntegrityTimeoutSeconds
  releaseIdentitySid = [string]$runtimeReceipt.identitySid
  releaseAclProtected = $true
  recoveryControllerVersion = [string]$recoveryController.controllerVersion
  recoveryControllerManifestSha256 = [string]$recoveryController.controllerManifestSha256
  repositoryHeadRequired = [bool]$RequireRepositoryHeadMatch
}
$result | ConvertTo-Json -Depth 10
