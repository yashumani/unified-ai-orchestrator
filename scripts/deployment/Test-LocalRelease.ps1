#requires -Version 7.4

[CmdletBinding()]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$ExpectedSha,
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [switch]$RequireRepositoryHeadMatch,
  [ValidateRange(1, 300)][int]$HealthTimeoutSeconds = 180,
  [ValidateRange(1, 600)][int]$IntegrityTimeoutSeconds = 180,
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
$manifest = Test-ReleaseDirectory -Layout $layout -ReleaseRoot $releaseRoot -ExpectedSha $ExpectedSha
$runtimeTimer = [System.Diagnostics.Stopwatch]::StartNew()
$runtimeReceipt = Test-RuntimeDependencyIntegrity `
  -Layout $layout `
  -ReleaseRoot $releaseRoot `
  -ExpectedSha $ExpectedSha `
  -ExpectedReceiptSha256 ([string]$pointer.runtimeDependencyReceiptSha256)
$runtimeTimer.Stop()
$aclTimer = [System.Diagnostics.Stopwatch]::StartNew()
[void](Assert-ReleaseDirectoryProtection -Layout $layout -ReleaseRoot $releaseRoot -IdentitySid ([string]$runtimeReceipt.identitySid))
$aclTimer.Stop()
if ($runtimeTimer.Elapsed.TotalSeconds -gt $IntegrityTimeoutSeconds -or
    $aclTimer.Elapsed.TotalSeconds -gt $IntegrityTimeoutSeconds) {
  throw "Release integrity or recursive ACL qualification exceeded the $IntegrityTimeoutSeconds-second production budget."
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
  packageLockSha256 = [string]$manifest.packageLockSha256
  runtimeTreeSha256 = [string]$runtimeReceipt.treeSha256
  runtimeFileCount = [int]$runtimeReceipt.fileCount
  runtimeLinkCount = [int]$runtimeReceipt.linkCount
  runtimeIntegrityMilliseconds = [int64]$runtimeTimer.ElapsedMilliseconds
  recursiveAclVerificationMilliseconds = [int64]$aclTimer.ElapsedMilliseconds
  integrityBudgetSeconds = $IntegrityTimeoutSeconds
  releaseIdentitySid = [string]$runtimeReceipt.identitySid
  releaseAclProtected = $true
  recoveryControllerVersion = [string]$recoveryController.controllerVersion
  recoveryControllerManifestSha256 = [string]$recoveryController.controllerManifestSha256
  repositoryHeadRequired = [bool]$RequireRepositoryHeadMatch
}
$result | ConvertTo-Json -Depth 10
