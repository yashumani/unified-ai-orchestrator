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
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task -and -not $AllowMissingTask) {
    throw "Scheduled task $TaskName is not installed."
  }
  if ($null -ne $task -and [string]$task.State -eq "Running") {
    if ($PSCmdlet.ShouldProcess($TaskName, "Stop repository-scoped scheduled task instance")) {
      Stop-ScheduledTask -TaskName $TaskName
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
  if (Test-Path -LiteralPath $layout.Process -PathType Leaf) {
    if ($PSCmdlet.ShouldProcess($layout.Process, "Remove stale process receipt")) {
      Remove-Item -LiteralPath $layout.Process -Force
    }
  }
} finally {
  Exit-DeploymentMutex -Mutex $mutex
}
