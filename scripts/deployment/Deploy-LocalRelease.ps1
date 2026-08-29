#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory)][string]$ArtifactPath,
  [Parameter(Mandatory)][string]$ExpectedSha,
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [string]$TaskName = "UnifiedAIOrchestrator-Local",
  [ValidateRange(1, 60)][int]$HealthTimeoutSeconds = 45
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
    payloadFiles = $manifest.payloadSha256.Count
  } | ConvertTo-Json -Depth 10
  return
}

Initialize-DeploymentLayout -Layout $layout
$transaction = Enter-DeploymentTransactionMutex
$operationId = Get-OperationId
$stagingRoot = Assert-ContainedPath -Root $layout.Staging -Path (Join-Path $layout.Staging "$ExpectedSha-$operationId")
$oldPointer = $null
$activationStarted = $false
$pendingWritten = $false
try {
  # Repeat every drift-prone preflight after acquiring the cross-session lock.
  [void](Assert-DeploymentSource -RepositoryRoot $RepositoryRoot -ExpectedSha $ExpectedSha)
  [void](Test-ReleaseArchive -ArtifactPath $ArtifactPath -ExpectedSha $ExpectedSha)
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  Write-DeploymentEvent -Layout $layout -Action "deploy" -Status "started" -CommitSha $ExpectedSha -OperationId $operationId -Message "Validated exact-SHA release artifact and canonical main source."

  if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
    [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $releaseRoot -ExpectedSha $ExpectedSha)
  } else {
    [void](New-Item -ItemType Directory -Path $stagingRoot)
    try {
      Expand-ValidatedReleaseArchive -ArtifactPath $ArtifactPath -DestinationRoot $stagingRoot
      [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $stagingRoot -ExpectedSha $ExpectedSha)
      $nodePath = Get-StableExecutable -Name "node.exe"
      [void](Assert-NodeRuntime -NodePath $nodePath)
      $npmPath = Get-StableExecutable -Name "npm.cmd"
      Push-Location $stagingRoot
      try {
        & $npmPath ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
          throw "npm ci failed with exit code $LASTEXITCODE."
        }
      } finally {
        Pop-Location
      }
      if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot "node_modules") -PathType Container)) {
        throw "npm ci did not produce the release node_modules directory."
      }
      [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $stagingRoot -ExpectedSha $ExpectedSha)
      Move-Item -LiteralPath $stagingRoot -Destination $releaseRoot
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
    [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $oldReleaseRoot -ExpectedSha ([string]$oldPointer.commitSha))
  }
  if (Test-Path -LiteralPath $layout.Pending -PathType Leaf) {
    throw "An unresolved pending deployment record exists; inspect and recover it before another activation."
  }
  [void](Backup-DeploymentState -Layout $layout -OperationId $operationId)
  Write-AtomicJson -Layout $layout -Path $layout.Pending -Value ([ordered]@{
      schemaVersion = 1
      commitSha = $ExpectedSha
      operationId = $operationId
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
      state = "activating"
    })
  $pendingWritten = $true

  $activationStarted = $true
  & (Join-Path $PSScriptRoot "Stop-LocalRelease.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -TaskName $TaskName `
    -Confirm:$false
  Write-AtomicJson -Layout $layout -Path $layout.Current -Value (New-ReleasePointer -CommitSha $ExpectedSha -Reason "deploy:$operationId")
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
  if (Test-Path -LiteralPath $layout.Pending -PathType Leaf) {
    Remove-Item -LiteralPath $layout.Pending -Force
  }
  Write-DeploymentEvent -Layout $layout -Action "deploy" -Status "succeeded" -CommitSha $ExpectedSha -OperationId $operationId -Message "Exact release process, readiness SHA, evidence readiness, and web document passed."
  [ordered]@{
    deployed = $true
    commitSha = $ExpectedSha
    releaseRoot = $releaseRoot
    processId = [int]$live.receipt.pid
    taskName = $TaskName
    healthUri = $HealthUri
    readinessUri = $script:CanonicalReadyUri
    previousSha = if ($null -eq $oldPointer) { $null } else { [string]$oldPointer.commitSha }
    operationId = $operationId
  } | ConvertTo-Json -Depth 10
} catch {
  $failure = $_.Exception.Message
  try {
    Write-DeploymentEvent -Layout $layout -Action "deploy" -Status "failed" -CommitSha $ExpectedSha -OperationId $operationId -Message $failure
  } catch {
    $failure = "$failure Deployment failure logging also failed."
  }
  $recoverySucceeded = -not $activationStarted
  if ($activationStarted) {
    try {
      & (Join-Path $PSScriptRoot "Stop-LocalRelease.ps1") `
        -RepositoryRoot $RepositoryRoot `
        -TaskName $TaskName `
        -Confirm:$false
      if ($null -ne $oldPointer) {
        Write-AtomicJson -Layout $layout -Path $layout.Current -Value $oldPointer
        Start-ScheduledTask -TaskName $TaskName
        [void](Wait-ForReleaseHealth -HealthUri $HealthUri -ExpectedSha ([string]$oldPointer.commitSha) -TimeoutSeconds $HealthTimeoutSeconds)
      } elseif (Test-Path -LiteralPath $layout.Current -PathType Leaf) {
        Remove-Item -LiteralPath $layout.Current -Force
      }
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
