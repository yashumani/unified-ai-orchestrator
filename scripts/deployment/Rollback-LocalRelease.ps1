#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory)][string]$ExpectedPreviousSha,
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [string]$TaskName = "UnifiedAIOrchestrator-Local",
  [ValidateRange(1, 60)][int]$HealthTimeoutSeconds = 45
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$ExpectedPreviousSha = Assert-CommitSha -CommitSha $ExpectedPreviousSha
[void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
[void](Assert-CanonicalTaskName -TaskName $TaskName)
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
Assert-NoDeploymentReparsePoints -Layout $layout

$transaction = Enter-DeploymentTransactionMutex
$operationId = Get-OperationId
$current = $null
$currentSha = $null
$targetSha = $ExpectedPreviousSha
$activationStarted = $false
$pendingWritten = $false
try {
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
  [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $targetRoot -ExpectedSha $targetSha)
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

  [void](Backup-DeploymentState -Layout $layout -OperationId $operationId)
  Write-AtomicJson -Layout $layout -Path $layout.Pending -Value ([ordered]@{
      schemaVersion = 1
      commitSha = $targetSha
      operationId = $operationId
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
      state = "rolling-back"
    })
  $pendingWritten = $true
  Write-DeploymentEvent -Layout $layout -Action "rollback" -Status "started" -CommitSha $targetSha -OperationId $operationId -Message "Rolling back deployed binaries and web bundle; canonical Git checkout is unchanged."
  $activationStarted = $true
  & (Join-Path $PSScriptRoot "Stop-LocalRelease.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -TaskName $TaskName `
    -Confirm:$false
  Write-AtomicJson -Layout $layout -Path $layout.Current -Value (New-ReleasePointer -CommitSha $targetSha -Reason "rollback:$operationId")
  Start-ScheduledTask -TaskName $TaskName
  [void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha $targetSha -TimeoutSeconds $HealthTimeoutSeconds)
  [void](Test-ReleaseWebDocument -ReleaseRoot $targetRoot -TimeoutSeconds 10)
  $live = Get-LiveReleaseProcess -Layout $layout -ExpectedSha $targetSha
  if ($null -eq $live) {
    throw "Rollback health passed but no exact rollback process receipt is live."
  }
  Write-AtomicJson -Layout $layout -Path $layout.Previous -Value $current
  Remove-Item -LiteralPath $layout.Pending -Force
  $pendingWritten = $false
  Write-DeploymentEvent -Layout $layout -Action "rollback" -Status "succeeded" -CommitSha $targetSha -OperationId $operationId -Message "Rollback health, readiness SHA, and web document passed."
  [ordered]@{
    rolledBack = $true
    commitSha = $targetSha
    previousSha = $currentSha
    processId = [int]$live.receipt.pid
    operationId = $operationId
  } | ConvertTo-Json -Depth 10
} catch {
  $failure = $_.Exception.Message
  try {
    Write-DeploymentEvent -Layout $layout -Action "rollback" -Status "failed" -CommitSha $targetSha -OperationId $operationId -Message $failure
  } catch {
    $failure = "$failure Rollback failure logging also failed."
  }
  $recoverySucceeded = -not $activationStarted
  if ($activationStarted -and $null -ne $current -and $null -ne $currentSha) {
    try {
      & (Join-Path $PSScriptRoot "Stop-LocalRelease.ps1") `
        -RepositoryRoot $RepositoryRoot `
        -TaskName $TaskName `
        -Confirm:$false
      Write-AtomicJson -Layout $layout -Path $layout.Current -Value $current
      Start-ScheduledTask -TaskName $TaskName
      [void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha $currentSha -TimeoutSeconds $HealthTimeoutSeconds)
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
