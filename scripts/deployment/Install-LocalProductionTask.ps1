#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$TaskName = "UnifiedAIOrchestrator-Local",
  [string]$ControllerSourceRoot = $PSScriptRoot,
  [string]$HealthUri = "http://127.0.0.1:8790/api/ready",
  [ValidateRange(1, 300)][int]$HealthTimeoutSeconds = 180
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
[void](Assert-CanonicalTaskName -TaskName $TaskName)
[void](Assert-CanonicalHealthUri -HealthUri $HealthUri)
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
$controllerSource = Test-RecoveryControllerManifest -Layout $layout -SourceRoot $ControllerSourceRoot
$controllerRoot = Get-RecoveryControllerRoot `
  -Layout $layout `
  -ControllerVersion ([string]$controllerSource.controllerVersion) `
  -ControllerManifestSha256 ([string]$controllerSource.controllerManifestSha256)
$startScript = Join-Path $controllerRoot "Start-LocalRelease.ps1"
$powerShellPath = Get-StableExecutable -Name "pwsh.exe"
$identity = Get-CurrentWindowsIdentityReceipt

$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$startScript`" -RepositoryRoot `"$RepositoryRoot`" -Supervised"

function New-ApplicationTaskDefinition {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$State)

  $action = New-ScheduledTaskAction `
    -Execute ([string]$State.powerShellPath) `
    -Argument ([string]$State.arguments)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([string]$State.identityName)
  $principal = New-ScheduledTaskPrincipal `
    -UserId ([string]$State.identityName) `
    -LogonType Interactive `
    -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -MultipleInstances IgnoreNew `
    -Hidden
  return (New-ScheduledTask `
      -Action $action `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Description $script:CanonicalDeploymentTaskDescription)
}

function Register-ApplicationTaskFromState {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$State)

  $definition = New-ApplicationTaskDefinition -State $State
  Register-ScheduledTask -TaskName ([string]$State.taskName) -InputObject $definition -Force | Out-Null
  return (Assert-ScheduledTaskContract `
      -TaskName ([string]$State.taskName) `
      -ExpectedExecute ([string]$State.powerShellPath) `
      -ExpectedArguments ([string]$State.arguments) `
      -ExpectedIdentitySid ([string]$State.identitySid) `
      -ExpectedDescription $script:CanonicalDeploymentTaskDescription)
}

function Assert-TaskInstallationSnapshot {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$State,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Controller
  )

  $requiredKeys = @(
    "schemaVersion", "repositoryRoot", "taskName", "powerShellPath", "arguments",
    "startScript", "controllerVersion", "controllerManifestSha256", "identityName",
    "identitySid", "installedAtUtc"
  )
  if (@($State.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $State.Keys }).Count -ne 0 -or
      [int]$State.schemaVersion -ne 1 -or
      [string]$State.repositoryRoot -cne $RepositoryRoot -or
      [string]$State.taskName -cne $TaskName -or
      [string]$State.controllerVersion -cne [string]$Controller.controllerVersion -or
      [string]$State.controllerManifestSha256 -cne [string]$Controller.controllerManifestSha256 -or
      [string]$State.identitySid -cne [string]$Controller.identitySid -or
      [string]$State.identityName -cne [string]$Controller.identityName) {
    throw "Controller-activation task snapshot does not match its immutable controller."
  }
  [void](Assert-UtcTimestamp -Value ([string]$State.installedAtUtc) -Context "Controller task installedAtUtc")
  $expectedStartScript = Join-Path ([string]$Controller.controllerRoot) "Start-LocalRelease.ps1"
  $expectedPowerShellPath = Get-StableExecutable -Name "pwsh.exe"
  $expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$expectedStartScript`" -RepositoryRoot `"$RepositoryRoot`" -Supervised"
  if (-not [string]::Equals([string]$State.startScript, $expectedStartScript, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$State.powerShellPath, $expectedPowerShellPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]$State.arguments -cne $expectedArguments -or
      (ConvertTo-WindowsSid -Identity ([string]$State.identityName)) -cne [string]$State.identitySid) {
    throw "Controller-activation task snapshot drifted from the exact scheduled-task contract."
  }
  return $State
}

function Assert-CurrentReleaseOperational {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Pointer)

  $commitSha = [string]$Pointer.commitSha
  $releaseRoot = Get-ReleaseRoot -Layout $layout -CommitSha $commitSha
  [void](Test-ReleaseDirectory -Layout $layout -ReleaseRoot $releaseRoot -ExpectedSha $commitSha)
  $runtimeReceipt = Test-RuntimeDependencyIntegrity `
    -Layout $layout `
    -ReleaseRoot $releaseRoot `
    -ExpectedSha $commitSha `
    -ExpectedReceiptSha256 ([string]$Pointer.runtimeDependencyReceiptSha256)
  [void](Assert-ReleaseDirectoryProtection `
      -Layout $layout `
      -ReleaseRoot $releaseRoot `
      -IdentitySid ([string]$runtimeReceipt.identitySid))
  [void](Wait-ForReleaseHealth `
      -HealthUri $HealthUri `
      -ExpectedSha $commitSha `
      -TimeoutSeconds $HealthTimeoutSeconds)
  [void](Test-ReleaseWebDocument -ReleaseRoot $releaseRoot -TimeoutSeconds 10)
  $live = Get-LiveReleaseProcess -Layout $layout -ExpectedSha $commitSha
  if ($null -eq $live) {
    throw "Controller task qualification passed readiness without the exact current release process."
  }
  return $live
}

function Stop-ApplicationForControllerRecovery {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$NextTask,
    [System.Collections.IDictionary]$PreviousTask
  )

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    $matchesKnownTask = $false
    foreach ($candidate in @($NextTask, $PreviousTask)) {
      if ($null -eq $candidate) {
        continue
      }
      try {
        [void](Assert-ScheduledTaskContract `
            -TaskName $TaskName `
            -ExpectedExecute ([string]$candidate.powerShellPath) `
            -ExpectedArguments ([string]$candidate.arguments) `
            -ExpectedIdentitySid ([string]$candidate.identitySid) `
            -ExpectedDescription $script:CanonicalDeploymentTaskDescription)
        $matchesKnownTask = $true
        break
      } catch {
      }
    }
    if (-not $matchesKnownTask) {
      throw "Controller-activation recovery found a scheduled task outside both exact snapshots."
    }
    if ([string]$task.State -in @("Running", "Queued")) {
      Stop-ScheduledTask -TaskName $TaskName
      $taskDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
      while ([string](Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop).State -ne "Ready") {
        if ([DateTimeOffset]::UtcNow -ge $taskDeadline) {
          throw "Controller-activation recovery could not stop scheduled task $TaskName."
        }
        Start-Sleep -Milliseconds 250
      }
    }
  }
  $live = Get-LiveReleaseProcess -Layout $layout
  if ($null -ne $live) {
    $pidValue = [int]$live.receipt.pid
    Stop-Process -Id $pidValue
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    while (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
      if ([DateTimeOffset]::UtcNow -ge $deadline) {
        throw "Controller-activation recovery could not stop process $pidValue."
      }
      Start-Sleep -Milliseconds 250
    }
  }
  if (Test-Path -LiteralPath $layout.Process -PathType Leaf) {
    Remove-Item -LiteralPath $layout.Process -Force
  }
}

function Move-ControllerActivationRecordToFailed {
  param([Parameter(Mandatory)][string]$Suffix)

  if (Test-Path -LiteralPath $layout.ControllerActivationPending -PathType Leaf) {
    $failedPath = Assert-ContainedPath `
      -Root $layout.Failed `
      -Path (Join-Path $layout.Failed "controller-activation-$Suffix-$([guid]::NewGuid().ToString('N')).json")
    Move-Item -LiteralPath $layout.ControllerActivationPending -Destination $failedPath
  }
}

function Restore-PendingControllerActivation {
  $pending = Read-JsonHashtable -Path $layout.ControllerActivationPending
  $required = @(
    "schemaVersion", "operationId", "hadPrevious", "previousControllerInstallation",
    "previousTaskInstallation", "nextControllerInstallation", "nextTaskInstallation",
    "currentReleaseSha", "currentRuntimeDependencyReceiptSha256", "createdAtUtc"
  )
  if (@($pending.Keys | Where-Object { $_ -notin $required }).Count -ne 0 -or
      @($required | Where-Object { $_ -notin $pending.Keys }).Count -ne 0 -or
      [int]$pending.schemaVersion -ne 2 -or
      [string]$pending.operationId -cnotmatch "^[0-9a-f]{32}$" -or
      $pending.hadPrevious -isnot [bool] -or
      $pending.nextControllerInstallation -isnot [System.Collections.IDictionary] -or
      $pending.nextTaskInstallation -isnot [System.Collections.IDictionary]) {
    throw "Pending controller activation record is invalid."
  }
  [void](Assert-UtcTimestamp -Value ([string]$pending.createdAtUtc) -Context "Controller activation createdAtUtc")
  $nextController = [System.Collections.IDictionary]$pending.nextControllerInstallation
  $nextTask = [System.Collections.IDictionary]$pending.nextTaskInstallation
  [void](Assert-RecoveryControllerInstallationValue -Layout $layout -State $nextController)
  [void](Assert-TaskInstallationSnapshot -State $nextTask -Controller $nextController)
  $previousController = $null
  $previousTask = $null
  if ([bool]$pending.hadPrevious) {
    if ($pending.previousControllerInstallation -isnot [System.Collections.IDictionary] -or
        $pending.previousTaskInstallation -isnot [System.Collections.IDictionary]) {
      throw "Pending controller activation is missing its prior exact snapshots."
    }
    $previousController = [System.Collections.IDictionary]$pending.previousControllerInstallation
    $previousTask = [System.Collections.IDictionary]$pending.previousTaskInstallation
    [void](Assert-RecoveryControllerInstallationValue -Layout $layout -State $previousController)
    [void](Assert-TaskInstallationSnapshot -State $previousTask -Controller $previousController)
  } elseif ($null -ne $pending.previousControllerInstallation -or
      $null -ne $pending.previousTaskInstallation) {
    throw "First controller activation cannot contain prior task snapshots."
  }
  $currentReleaseSha = [string]$pending.currentReleaseSha
  if ([string]::IsNullOrWhiteSpace($currentReleaseSha)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$pending.currentRuntimeDependencyReceiptSha256)) {
      throw "Controller activation has runtime identity without a current release."
    }
  } else {
    [void](Assert-CommitSha -CommitSha $currentReleaseSha)
    if ([string]$pending.currentRuntimeDependencyReceiptSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        -not [bool]$pending.hadPrevious) {
      throw "Controller activation current-release recovery identity is invalid."
    }
    $currentPointer = Read-ReleasePointer -Path $layout.Current
    if ([string]$currentPointer.commitSha -cne $currentReleaseSha -or
        [string]$currentPointer.runtimeDependencyReceiptSha256 -cne [string]$pending.currentRuntimeDependencyReceiptSha256) {
      throw "Current release changed during controller activation recovery."
    }
  }

  Stop-ApplicationForControllerRecovery -NextTask $nextTask -PreviousTask $previousTask
  if ([bool]$pending.hadPrevious) {
    [void](Register-ApplicationTaskFromState -State $previousTask)
    Write-AtomicJson -Layout $layout -Path $layout.ControllerInstallation -Value $previousController
    Write-AtomicJson -Layout $layout -Path $layout.TaskInstallation -Value $previousTask
    [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  } else {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
      [void](Assert-ScheduledTaskContract `
          -TaskName $TaskName `
          -ExpectedExecute ([string]$nextTask.powerShellPath) `
          -ExpectedArguments ([string]$nextTask.arguments) `
          -ExpectedIdentitySid ([string]$nextTask.identitySid) `
          -ExpectedDescription $script:CanonicalDeploymentTaskDescription)
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    foreach ($statePath in @($layout.TaskInstallation, $layout.ControllerInstallation)) {
      if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        Remove-Item -LiteralPath $statePath -Force
      }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($currentReleaseSha)) {
    Start-ScheduledTask -TaskName $TaskName
    [void](Assert-CurrentReleaseOperational -Pointer $currentPointer)
  }
  Move-ControllerActivationRecordToFailed -Suffix "recovered"
  try {
    Write-DeploymentEvent -Layout $layout -Action "activate-recovery-controller" -Status "info" -Message "Recovered an interrupted recovery-controller activation to its prior exact task state and current release."
  } catch {
    Write-Warning "Controller activation recovery committed but event logging failed: $($_.Exception.Message)"
  }
}

if (-not $PSCmdlet.ShouldProcess(
    "$TaskName for $([string]$identity.identityName)",
    "Stage and transactionally activate the immutable recovery controller for the password-free supervised task"
  )) {
  [ordered]@{
    whatIf = $true
    taskName = $TaskName
    taskIdentity = [string]$identity.identityName
    taskIdentitySid = [string]$identity.identitySid
    controllerVersion = [string]$controllerSource.controllerVersion
    controllerManifestSha256 = [string]$controllerSource.controllerManifestSha256
    controllerRoot = $controllerRoot
    startScript = $startScript
  } | ConvertTo-Json -Depth 10
  return
}

Initialize-DeploymentLayout -Layout $layout
$transaction = Enter-DeploymentTransactionMutex
try {
if ([bool]$transaction.WasAbandoned) {
  Assert-NoDeploymentReparsePoints -Layout $layout
  Write-DeploymentEvent -Layout $layout -Action "lock-recovery" -Status "info" -Message "Recovered an abandoned controller-activation transaction mutex after revalidating deployment paths."
}
Assert-NoForeignDeploymentPendingRecords `
  -Layout $layout `
  -AllowedPaths @($layout.ControllerActivationPending)
if (Test-Path -LiteralPath $layout.ControllerActivationPending -PathType Leaf) {
  Restore-PendingControllerActivation
}
Assert-NoForeignDeploymentPendingRecords -Layout $layout
$existing = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
if ($existing.Count -gt 1) {
  throw "More than one scheduled task matched the canonical application task name."
}
$hasTaskState = Test-Path -LiteralPath $layout.TaskInstallation -PathType Leaf
$hasControllerState = Test-Path -LiteralPath $layout.ControllerInstallation -PathType Leaf
if ((($existing.Count -eq 1) -ne $hasTaskState) -or
    ($hasTaskState -ne $hasControllerState)) {
  throw "Application task and controller activation state are incomplete; refusing an ambiguous replacement."
}
$currentPointer = $null
if (Test-Path -LiteralPath $layout.Current -PathType Leaf) {
  if ($existing.Count -ne 1) {
    throw "A current release requires an exact existing controller task before controller replacement."
  }
  $currentPointer = Read-ReleasePointer -Path $layout.Current
}
$previousControllerInstallation = $null
$previousTaskInstallation = $null
if ($existing.Count -eq 1) {
  $previousControllerInstallation = Read-RecoveryControllerInstallation -Layout $layout
  $previousTaskInstallation = Read-DeploymentTaskInstallation -Layout $layout
  $existingTask = Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName
  if ($null -ne $currentPointer) {
    [void](Assert-CurrentReleaseOperational -Pointer $currentPointer)
  }
  if ([string]$previousControllerInstallation.controllerManifestSha256 -ceq [string]$controllerSource.controllerManifestSha256) {
    Write-Output "Local-production task $TaskName already uses recovery controller $([string]$controllerSource.controllerManifestSha256); state is $($existingTask.State)."
    return
  }
}
$controllerInstaller = Join-Path $PSScriptRoot "Install-RecoveryController.ps1"
$controllerInstallOutput = & $controllerInstaller `
  -RepositoryRoot $RepositoryRoot `
  -SourceRoot $ControllerSourceRoot `
  -Confirm:$false
$controllerInstallOutput = $null
[void](Test-InstalledRecoveryController `
    -Layout $layout `
    -ControllerRoot $controllerRoot `
    -ExpectedManifestSha256 ([string]$controllerSource.controllerManifestSha256) `
    -IdentitySid ([string]$identity.identitySid))
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
  throw "Installed recovery-controller launcher does not exist: $startScript"
}

$controllerInstallation = [ordered]@{
  schemaVersion = 1
  controllerVersion = [string]$controllerSource.controllerVersion
  controllerManifestSha256 = [string]$controllerSource.controllerManifestSha256
  controllerRoot = $controllerRoot
  identityName = [string]$identity.identityName
  identitySid = [string]$identity.identitySid
  installedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
}
$installation = [ordered]@{
  schemaVersion = 1
  repositoryRoot = $RepositoryRoot
  taskName = $TaskName
  powerShellPath = $powerShellPath
  arguments = $arguments
  startScript = $startScript
  controllerVersion = [string]$controllerSource.controllerVersion
  controllerManifestSha256 = [string]$controllerSource.controllerManifestSha256
  identityName = [string]$identity.identityName
  identitySid = [string]$identity.identitySid
  installedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
}
$activationOperationId = [guid]::NewGuid().ToString("N")
Write-AtomicJson -Layout $layout -Path $layout.ControllerActivationPending -Value ([ordered]@{
    schemaVersion = 2
    operationId = $activationOperationId
    hadPrevious = $null -ne $previousControllerInstallation
    previousControllerInstallation = $previousControllerInstallation
    previousTaskInstallation = $previousTaskInstallation
    nextControllerInstallation = $controllerInstallation
    nextTaskInstallation = $installation
    currentReleaseSha = if ($null -eq $currentPointer) { $null } else { [string]$currentPointer.commitSha }
    currentRuntimeDependencyReceiptSha256 = if ($null -eq $currentPointer) { $null } else { [string]$currentPointer.runtimeDependencyReceiptSha256 }
    createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  })
try {
  if ($null -ne $currentPointer) {
    $previousStopScript = Join-Path ([string]$previousControllerInstallation.controllerRoot) "Stop-LocalRelease.ps1"
    & $previousStopScript `
      -RepositoryRoot $RepositoryRoot `
      -TaskName $TaskName `
      -Confirm:$false
  }
  [void](Register-ApplicationTaskFromState -State $installation)
  Write-AtomicJson -Layout $layout -Path $layout.ControllerInstallation -Value $controllerInstallation
  Write-AtomicJson -Layout $layout -Path $layout.TaskInstallation -Value $installation
  [void](Assert-DeploymentTaskRegistration -RepositoryRoot $RepositoryRoot -TaskName $TaskName)
  if ($null -ne $currentPointer) {
    Start-ScheduledTask -TaskName $TaskName
    [void](Assert-CurrentReleaseOperational -Pointer $currentPointer)
  }
  Remove-Item -LiteralPath $layout.ControllerActivationPending -Force
} catch {
  $installFailure = $_.Exception.Message
  try {
    Restore-PendingControllerActivation
  } catch {
    $installFailure = "$installFailure Controller activation recovery also failed: $($_.Exception.Message)"
  }
  throw $installFailure
}
try {
  Write-DeploymentEvent -Layout $layout -Action "activate-recovery-controller" -Status "succeeded" -Message "Activated and behaviorally qualified immutable recovery controller $([string]$controllerSource.controllerManifestSha256) for the password-free task."
} catch {
  Write-Warning "Controller activation committed but event logging failed: $($_.Exception.Message)"
}
Write-Output "Activated scheduled task $TaskName with recovery controller $([string]$controllerSource.controllerManifestSha256) for $([string]$identity.identityName)."
} finally {
  Exit-DeploymentMutex -Mutex $transaction
}
