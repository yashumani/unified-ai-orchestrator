#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$TaskName = "UnifiedAIOrchestrator-Local",
  [switch]$StopRunningRelease
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
[void](Assert-CanonicalTaskName -TaskName $TaskName)
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
  Write-Output "Scheduled task $TaskName is not installed."
  return
}
[void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)

if ($StopRunningRelease) {
  & (Join-Path $PSScriptRoot "Stop-LocalRelease.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -TaskName $TaskName `
    -Confirm:$false `
    -WhatIf:$WhatIfPreference
}
if (-not $PSCmdlet.ShouldProcess($TaskName, "Unregister exact repository-scoped scheduled task")) {
  return
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
if (Test-Path -LiteralPath $layout.Root -PathType Container) {
  if (Test-Path -LiteralPath $layout.TaskInstallation -PathType Leaf) {
    $archivedState = Assert-ContainedPath `
      -Root $layout.Failed `
      -Path (Join-Path $layout.Failed "removed-task-installation-$([guid]::NewGuid().ToString('N')).json")
    Move-Item -LiteralPath $layout.TaskInstallation -Destination $archivedState
  }
  Write-DeploymentEvent -Layout $layout -Action "remove-task" -Status "succeeded" -Message "Unregistered repository-scoped task; deployment files were preserved."
}
Write-Output "Removed scheduled task $TaskName. Deployment releases, state, logs, evidence, and secrets were not deleted."
