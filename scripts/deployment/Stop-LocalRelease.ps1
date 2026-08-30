#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$TaskName = "UnifiedAIOrchestrator-Local",
  [ValidateRange(1, 30)][int]$TimeoutSeconds = 15,
  [switch]$AllowMissingTask
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
[void](Assert-CanonicalTaskName -TaskName $TaskName)
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
Assert-NoDeploymentReparsePoints -Layout $layout
$mutex = Enter-DeploymentMutex
try {
  if ([bool]$mutex.WasAbandoned) {
    Assert-NoDeploymentReparsePoints -Layout $layout
    Write-DeploymentEvent -Layout $layout -Action "lock-recovery" -Status "info" -Message "Recovered an abandoned deployment-state mutex after revalidating deployment paths."
  }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task -and -not $AllowMissingTask) {
    throw "Scheduled task $TaskName is not installed."
  }
  if ($null -ne $task) {
    [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  }
  $taskStopRequested = $false
  if ($null -ne $task -and [string]$task.State -in @("Running", "Queued")) {
    if ($PSCmdlet.ShouldProcess($TaskName, "Stop repository-scoped scheduled task instance")) {
      Stop-ScheduledTask -TaskName $TaskName
      $taskStopRequested = $true
    }
  }

  $live = Get-LiveReleaseProcess -Layout $layout
  if ($null -ne $live) {
    $pidValue = [int]$live.receipt.pid
    if ($PSCmdlet.ShouldProcess("PID $pidValue", "Stop exact recorded orchestrator Node.js process")) {
      Stop-Process -Id $pidValue
      $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
      while (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
          throw "Recorded process $pidValue did not stop within $TimeoutSeconds seconds."
        }
        Start-Sleep -Milliseconds 250
      }
      Write-DeploymentEvent -Layout $layout -Action "stop" -Status "succeeded" -CommitSha ([string]$live.receipt.commitSha) -Message "Stopped exact recorded process $pidValue."
    }
  }
  if ($taskStopRequested) {
    $taskDeadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ($true) {
      $taskState = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop).State
      if ($taskState -eq "Ready") {
        break
      }
      if ([DateTimeOffset]::UtcNow -ge $taskDeadline) {
        throw "Scheduled task $TaskName remained $taskState after $TimeoutSeconds seconds."
      }
      Start-Sleep -Milliseconds 250
    }
  }
  if (Test-Path -LiteralPath $layout.Process -PathType Leaf) {
    if ($PSCmdlet.ShouldProcess($layout.Process, "Remove stale process receipt")) {
      Remove-Item -LiteralPath $layout.Process -Force
    }
  }
} finally {
  Exit-DeploymentMutex -Mutex $mutex
}
