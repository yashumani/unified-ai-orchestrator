#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$TaskName = "UnifiedAIOrchestrator-Local"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
[void](Assert-CanonicalTaskName -TaskName $TaskName)
$startScript = Join-Path $RepositoryRoot "scripts\deployment\Start-LocalRelease.ps1"
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
  throw "Scheduled-task launcher does not exist: $startScript"
}
$powerShellPath = Get-StableExecutable -Name "pwsh.exe"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($identity)) {
  throw "Unable to resolve the current Windows identity."
}

$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$startScript`" -RepositoryRoot `"$RepositoryRoot`" -Supervised"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  $actions = @($existing.Actions)
  if (
    $actions.Count -ne 1 -or
    -not [string]::Equals([string]$actions[0].Execute, $powerShellPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    [string]$actions[0].Arguments -cne $arguments
  ) {
    throw "A task named $TaskName already exists with a different action; refusing to replace it."
  }
}

if (-not $PSCmdlet.ShouldProcess(
    "$TaskName for $identity",
    "Register password-free, current-user, repository-scoped supervised startup task"
  )) {
  return
}

$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
Initialize-DeploymentLayout -Layout $layout
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -MultipleInstances IgnoreNew `
  -Hidden
$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Supervises the loopback-only Unified AI Orchestrator release selected by the repository deployment pointer."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
[void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
Write-DeploymentEvent -Layout $layout -Action "install-task" -Status "succeeded" -Message "Registered password-free Interactive task for $identity."
Write-Output "Installed scheduled task $TaskName for $identity without storing a password."
