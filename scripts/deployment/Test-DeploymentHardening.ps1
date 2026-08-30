#requires -Version 7.4

[CmdletBinding()]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

if (-not $IsWindows) {
  throw "Deployment hardening tests require Windows ScheduledTasks and NTFS junction semantics."
}
$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
Initialize-DeploymentLayout -Layout $layout
$identity = Get-CurrentWindowsIdentityReceipt
$nodeRuntimeTimer = [System.Diagnostics.Stopwatch]::StartNew()
$nodeRuntime = Read-PinnedNodeRuntimeInstallation -Layout $layout -ExecuteVersionChecks
$nodeRuntimeTimer.Stop()
$entrypointFixtureRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "entrypoint-contract-$([guid]::NewGuid().ToString('N'))")
try {
  $entrypointFixtureDist = Join-Path $entrypointFixtureRoot "apps\api\dist"
  [void](New-Item -ItemType Directory -Path $entrypointFixtureDist -Force)
  [System.IO.File]::WriteAllText(
    (Join-Path $entrypointFixtureDist "server.js"),
    "legacy",
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $entrypointFixtureDist "server.bundle.mjs"),
    "bundle",
    [System.Text.UTF8Encoding]::new($false)
  )
  foreach ($legacySchema in @(3, 4, 5)) {
    $legacyEntrypoint = Get-ReleaseServerEntrypoint `
      -ReleaseRoot $entrypointFixtureRoot `
      -RuntimeReceipt ([ordered]@{ schemaVersion = $legacySchema })
    if ([System.IO.Path]::GetFileName($legacyEntrypoint) -cne "server.js") {
      throw "Legacy receipt schema $legacySchema did not select server.js."
    }
  }
  $bundledEntrypoint = Get-ReleaseServerEntrypoint `
    -ReleaseRoot $entrypointFixtureRoot `
    -RuntimeReceipt ([ordered]@{ schemaVersion = 6 })
  if ([System.IO.Path]::GetFileName($bundledEntrypoint) -cne "server.bundle.mjs") {
    throw "Bundled receipt schema 6 did not select server.bundle.mjs."
  }
  $unsupportedEntrypointRejected = $false
  try {
    [void](Get-ReleaseServerEntrypoint `
        -ReleaseRoot $entrypointFixtureRoot `
        -RuntimeReceipt ([ordered]@{ schemaVersion = 2 }))
  } catch {
    $unsupportedEntrypointRejected = $true
  }
  if (-not $unsupportedEntrypointRejected) {
    throw "Unsupported runtime receipt schema selected a server entrypoint."
  }
} finally {
  if (Test-Path -LiteralPath $entrypointFixtureRoot) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $entrypointFixtureRoot)
    Remove-Item -LiteralPath $entrypointFixtureRoot -Recurse -Force
  }
}
$powerShellPath = Get-StableExecutable -Name "pwsh.exe"
$expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"C:\reviewed\Start.ps1`""

$boundedJobMarker = "uai-bounded-job-$([guid]::NewGuid().ToString('N'))"
$boundedJobChildCommand = "`$boundedJobMarker = '$boundedJobMarker'; Start-Sleep -Seconds 30"
$boundedJobChildCommandLiteral = $boundedJobChildCommand.Replace("'", "''")
$boundedJobRootCommand = "Start-Process -FilePath '$powerShellPath' -ArgumentList @('-NoProfile','-Command','$boundedJobChildCommandLiteral') -NoNewWindow | Out-Null"
$boundedJobTimedOut = $false
try {
  [void](Invoke-BoundedProcess `
      -FilePath $powerShellPath `
      -ArgumentList @("-NoProfile", "-Command", $boundedJobRootCommand) `
      -WorkingDirectory $RepositoryRoot `
      -TimeoutSeconds 2 `
      -MaxOutputCharacters 4096 `
      -Context "Synthetic exited-parent process-tree fixture")
} catch {
  if ($_.Exception.Message -like "*exceeded its 2-second bound*") {
    $boundedJobTimedOut = $true
  } else {
    throw
  }
}
Start-Sleep -Milliseconds 500
$boundedJobSurvivors = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $PID -and
      [string]$_.CommandLine -like "*$boundedJobMarker*"
    }
)
if (-not $boundedJobTimedOut -or $boundedJobSurvivors.Count -ne 0) {
  foreach ($survivor in $boundedJobSurvivors) {
    Stop-Process -Id ([int]$survivor.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  throw "Bounded process job did not terminate an exited parent's descendant process tree."
}

$idleWatchdogMarker = "uai-idle-watchdog-$([guid]::NewGuid().ToString('N'))"
$idleWatchdogCommand = "`$idleWatchdogMarker = '$idleWatchdogMarker'; Start-Sleep -Seconds 30"
$idleWatchdogTriggered = $false
try {
  [void](Invoke-BoundedProcess `
      -FilePath $powerShellPath `
      -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-Command", $idleWatchdogCommand) `
      -WorkingDirectory $RepositoryRoot `
      -TimeoutSeconds 10 `
      -IdleTimeoutSeconds 1 `
      -MaxOutputCharacters 4096 `
      -Context "Synthetic no-progress watchdog fixture")
} catch {
  if ($_.Exception.Message -like "*made no observable progress for 1 seconds*") {
    $idleWatchdogTriggered = $true
  } else {
    throw
  }
}
Start-Sleep -Milliseconds 500
$idleWatchdogSurvivors = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $PID -and
      [string]$_.CommandLine -like "*$idleWatchdogMarker*"
    }
)
if (-not $idleWatchdogTriggered -or $idleWatchdogSurvivors.Count -ne 0) {
  foreach ($survivor in $idleWatchdogSurvivors) {
    Stop-Process -Id ([int]$survivor.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  throw "Bounded process no-progress watchdog did not terminate its silent process."
}

function Invoke-AbandonedMutexChild {
  param([Parameter(Mandatory)][string]$MutexName)

  $guardian = [System.Threading.Mutex]::new($false, $MutexName)
  $source = @"
`$mutex = [System.Threading.Mutex]::new(`$false, '$MutexName')
[void]`$mutex.WaitOne()
[Environment]::Exit(0)
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
  $child = Start-Process `
    -FilePath $powerShellPath `
    -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", $encoded) `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($child.ExitCode -ne 0) {
    $guardian.Dispose()
    throw "Abandoned-mutex child failed with exit code $($child.ExitCode)."
  }
  return $guardian
}

$stateMutexGuardian = Invoke-AbandonedMutexChild -MutexName "Global\UnifiedAIOrchestratorDeploymentState"
$recoveredStateMutex = Enter-DeploymentMutex
try {
  if (-not [bool]$recoveredStateMutex.WasAbandoned) {
    throw "Deployment-state mutex abandonment was not reported as recovered."
  }
} finally {
  Exit-DeploymentMutex -Mutex $recoveredStateMutex
  $stateMutexGuardian.Dispose()
}
$transactionMutexGuardian = Invoke-AbandonedMutexChild -MutexName "Global\UnifiedAIOrchestratorDeploymentTransaction"
$recoveredTransactionMutex = Enter-DeploymentTransactionMutex
try {
  if (-not [bool]$recoveredTransactionMutex.WasAbandoned) {
    throw "Deployment transaction mutex abandonment was not reported as recovered."
  }
} finally {
  Exit-DeploymentMutex -Mutex $recoveredTransactionMutex
  $transactionMutexGuardian.Dispose()
}

function New-ReviewedTaskDefinition {
  return [pscustomobject]@{
    TaskName = "Reviewed-Test-Task"
    TaskPath = "\"
    Description = "Reviewed task definition"
    Actions = @([pscustomobject]@{
        Execute = $powerShellPath
        Arguments = $expectedArguments
        WorkingDirectory = ""
      })
    Principal = [pscustomobject]@{
      UserId = [string]$identity.identitySid
      LogonType = "Interactive"
      RunLevel = "Limited"
      ProcessTokenSidType = "Default"
      RequiredPrivilege = $null
      GroupId = $null
    }
    Triggers = @([pscustomobject]@{
        Enabled = $true
        UserId = [string]$identity.identitySid
        Delay = $null
        StartBoundary = $null
        EndBoundary = $null
        ExecutionTimeLimit = $null
        Repetition = [pscustomobject]@{
          Duration = $null
          Interval = $null
          StopAtDurationEnd = $false
        }
        CimClass = [pscustomobject]@{ CimClassName = "MSFT_TaskLogonTrigger" }
      })
    Settings = [pscustomobject]@{
      RestartCount = 3
      RestartInterval = "PT1M"
      ExecutionTimeLimit = "P3650D"
      MultipleInstances = "IgnoreNew"
      Compatibility = "Win7"
      AllowDemandStart = $true
      AllowHardTerminate = $true
      Enabled = $true
      Priority = 7
      Hidden = $true
      StartWhenAvailable = $true
      DisallowStartIfOnBatteries = $false
      StopIfGoingOnBatteries = $false
      RunOnlyIfIdle = $false
      RunOnlyIfNetworkAvailable = $false
      WakeToRun = $false
      DisallowStartOnRemoteAppSession = $false
      UseUnifiedSchedulingEngine = $true
      volatile = $false
      MaintenanceSettings = $null
      DeleteExpiredTaskAfter = $null
      IdleSettings = [pscustomobject]@{
        IdleDuration = "PT10M"
        RestartOnIdle = $false
        StopOnIdleEnd = $true
        WaitTimeout = "PT1H"
      }
      NetworkSettings = [pscustomobject]@{ Id = $null; Name = $null }
    }
  }
}

function Assert-ReviewedTaskFails {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Mutate
  )
  $task = New-ReviewedTaskDefinition
  & $Mutate $task
  try {
    [void](Assert-ScheduledTaskDefinition `
        -Task $task `
        -ExpectedTaskName "Reviewed-Test-Task" `
        -ExpectedExecute $powerShellPath `
        -ExpectedArguments $expectedArguments `
        -ExpectedIdentitySid ([string]$identity.identitySid) `
        -ExpectedDescription "Reviewed task definition")
  } catch {
    return
  }
  throw "Scheduled-task mutation '$Name' was incorrectly accepted."
}

$baseline = New-ReviewedTaskDefinition
[void](Assert-ScheduledTaskDefinition `
    -Task $baseline `
    -ExpectedTaskName "Reviewed-Test-Task" `
    -ExpectedExecute $powerShellPath `
    -ExpectedArguments $expectedArguments `
    -ExpectedIdentitySid ([string]$identity.identitySid) `
    -ExpectedDescription "Reviewed task definition")

$mutations = [ordered]@{
  taskPath = { param($task) $task.TaskPath = "\Other\" }
  actionCount = { param($task) $task.Actions = @($task.Actions[0], $task.Actions[0]) }
  actionArguments = { param($task) $task.Actions[0].Arguments += " -Changed" }
  actionWorkingDirectory = { param($task) $task.Actions[0].WorkingDirectory = "C:\" }
  principalSid = { param($task) $task.Principal.UserId = "S-1-5-18" }
  principalLogon = { param($task) $task.Principal.LogonType = "Password" }
  principalRunLevel = { param($task) $task.Principal.RunLevel = "Highest" }
  principalToken = { param($task) $task.Principal.ProcessTokenSidType = "Unrestricted" }
  triggerCount = { param($task) $task.Triggers = @($task.Triggers[0], $task.Triggers[0]) }
  triggerType = { param($task) $task.Triggers[0].CimClass.CimClassName = "MSFT_TaskTimeTrigger" }
  triggerSid = { param($task) $task.Triggers[0].UserId = "S-1-5-18" }
  triggerEnabled = { param($task) $task.Triggers[0].Enabled = $false }
  restartCount = { param($task) $task.Settings.RestartCount = 4 }
  restartInterval = { param($task) $task.Settings.RestartInterval = "PT2M" }
  executionLimit = { param($task) $task.Settings.ExecutionTimeLimit = "PT1H" }
  multipleInstances = { param($task) $task.Settings.MultipleInstances = "Parallel" }
  hidden = { param($task) $task.Settings.Hidden = $false }
  startWhenAvailable = { param($task) $task.Settings.StartWhenAvailable = $false }
  batteriesStart = { param($task) $task.Settings.DisallowStartIfOnBatteries = $true }
  batteriesStop = { param($task) $task.Settings.StopIfGoingOnBatteries = $true }
}
foreach ($mutation in $mutations.GetEnumerator()) {
  Assert-ReviewedTaskFails -Name ([string]$mutation.Key) -Mutate $mutation.Value
}

$safePayloadRoot = Join-Path $layout.Staging "safe-payload-path-test"
$safePayloadPath = Assert-SafePayloadPath `
  -RelativePath "apps/web/dist/index.html" `
  -DestinationRoot $safePayloadRoot
[void](Assert-ContainedPath -Root $safePayloadRoot -Path $safePayloadPath)
$unsafePayloadPaths = @(
  "apps/web/index.html:secret",
  "apps/web/bad<name>.html",
  "apps/web/trailing.",
  "apps/web/trailing ",
  "apps/CON/readme.txt",
  "apps/prn.json",
  "apps/COM1/config.json",
  "apps/Lpt9.txt",
  "apps/CONIN`$/input.txt",
  "apps/bad$([char]1)name.txt"
)
foreach ($unsafePayloadPath in $unsafePayloadPaths) {
  $unsafeRejected = $false
  try {
    [void](Assert-SafePayloadPath -RelativePath $unsafePayloadPath -DestinationRoot $safePayloadRoot)
  } catch {
    $unsafeRejected = $true
  }
  if (-not $unsafeRejected) {
    throw "Windows-unsafe release payload path was incorrectly accepted: $unsafePayloadPath"
  }
}

$jsonDateRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "json-date-test-$([guid]::NewGuid().ToString('N'))")
try {
  [void](New-Item -ItemType Directory -Path $jsonDateRoot)
  $jsonDatePath = Join-Path $jsonDateRoot "date.json"
  Write-AtomicJson -Layout $layout -Path $jsonDatePath -Value ([ordered]@{
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    })
  $jsonDate = Read-JsonHashtable -Path $jsonDatePath
  if ($jsonDate.createdAtUtc -isnot [string]) {
    throw "JSON state reader converted a governed UTC timestamp away from its exact string form."
  }
  [void](Assert-UtcTimestamp -Value ([string]$jsonDate.createdAtUtc) -Context "JSON date regression")
} finally {
  if (Test-Path -LiteralPath $jsonDateRoot) {
    Remove-Item -LiteralPath $jsonDateRoot -Recurse -Force
  }
}

$reparseTestRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "reparse-tree-test-$([guid]::NewGuid().ToString('N'))")
$reparseTarget = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "reparse-tree-target-$([guid]::NewGuid().ToString('N'))")
try {
  [void](New-Item -ItemType Directory -Path $reparseTestRoot)
  [void](New-Item -ItemType Directory -Path $reparseTarget)
  [void](New-Item -ItemType Junction -Path (Join-Path $reparseTestRoot "escape") -Target $reparseTarget)
  $nestedReparseRejected = $false
  try {
    [void](Assert-TreeContainsNoReparsePoints -Root $reparseTestRoot)
  } catch {
    $nestedReparseRejected = $true
  }
  if (-not $nestedReparseRejected) {
    throw "Recursive quarantine preflight accepted a nested reparse point."
  }
} finally {
  $junctionPath = Join-Path $reparseTestRoot "escape"
  if (Test-Path -LiteralPath $junctionPath) {
    Remove-Item -LiteralPath $junctionPath -Force
  }
  foreach ($path in @($reparseTestRoot, $reparseTarget)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}

$pendingFixtureRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "pending-exclusivity-test-$([guid]::NewGuid().ToString('N'))")
$pendingFixture = [ordered]@{
  Pending = Join-Path $pendingFixtureRoot "pending.json"
  ReleaseInstallationPending = Join-Path $pendingFixtureRoot "release-install.json"
  ControllerInstallationPending = Join-Path $pendingFixtureRoot "controller-install.json"
  ControllerActivationPending = Join-Path $pendingFixtureRoot "controller-activation.json"
  NodeRuntimeInstallationPending = Join-Path $pendingFixtureRoot "node-install.json"
}
try {
  [void](New-Item -ItemType Directory -Path $pendingFixtureRoot)
  [System.IO.File]::WriteAllText($pendingFixture.NodeRuntimeInstallationPending, "{}")
  Assert-NoForeignDeploymentPendingRecords `
    -Layout $pendingFixture `
    -AllowedPaths @($pendingFixture.NodeRuntimeInstallationPending)
  $foreignPendingRejected = $false
  try {
    Assert-NoForeignDeploymentPendingRecords -Layout $pendingFixture
  } catch {
    $foreignPendingRejected = $true
  }
  if (-not $foreignPendingRejected) {
    throw "Cross-transaction pending-state exclusivity was not enforced."
  }
} finally {
  if (Test-Path -LiteralPath $pendingFixtureRoot) {
    Remove-Item -LiteralPath $pendingFixtureRoot -Recurse -Force
  }
}

$controllerReceipt = Test-RecoveryControllerManifest -Layout $layout -SourceRoot $PSScriptRoot
$emptyAclReleaseName = "$([guid]::NewGuid().ToString('N'))$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$emptyAclProtectionRoot = Assert-ContainedPath `
  -Root $layout.Releases `
  -Path (Join-Path $layout.Releases $emptyAclReleaseName)
$emptyAclOutsideRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "acl-empty-allowlist-target-$([guid]::NewGuid().ToString('N'))")
$emptyAclUndeclaredJunction = Join-Path $emptyAclProtectionRoot "node_modules\undeclared-link"
$emptyAclProtectionReceipt = $null
$emptyAclUndeclaredJunctionRejected = $false
try {
  foreach ($directory in @(
      (Join-Path $emptyAclProtectionRoot "apps\api"),
      (Join-Path $emptyAclProtectionRoot "node_modules\plain")
    )) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $emptyAclProtectionRoot "apps\api\index.js"),
    "api`n"
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $emptyAclProtectionRoot "node_modules\plain\index.js"),
    "dependency`n"
  )
  $emptyAclCriticalPaths = [System.Collections.Generic.List[string]]::new()
  for ($criticalPathIndex = 1; $criticalPathIndex -le 8; $criticalPathIndex++) {
    $criticalPath = Join-Path $emptyAclProtectionRoot "critical-$($criticalPathIndex.ToString('00')).txt"
    [System.IO.File]::WriteAllText($criticalPath, "critical-$criticalPathIndex`n")
    $emptyAclCriticalPaths.Add($criticalPath)
  }
  [void](New-Item -ItemType Directory -Path $emptyAclOutsideRoot)
  [System.IO.File]::WriteAllText((Join-Path $emptyAclOutsideRoot "outside.txt"), "outside`n")
  $emptyAclOutsideBefore = (Get-Acl -LiteralPath $emptyAclOutsideRoot).Sddl
  [void](New-Item -ItemType Junction -Path $emptyAclUndeclaredJunction -Target $emptyAclOutsideRoot)
  $emptyAclIdentitySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  try {
    [void](Protect-ReleaseDirectory `
        -Layout $layout `
        -ReleaseRoot $emptyAclProtectionRoot `
        -IdentitySid $emptyAclIdentitySid `
        -CriticalPaths @($emptyAclCriticalPaths) `
        -WorkspaceLinks @())
  } catch {
    if ($_.Exception.Message -like "*undeclared or unsupported reparse point*") {
      $emptyAclUndeclaredJunctionRejected = $true
    } else {
      throw
    }
  }
  $emptyAclOutsideAfter = (Get-Acl -LiteralPath $emptyAclOutsideRoot).Sddl
  if (-not $emptyAclUndeclaredJunctionRejected -or
      $emptyAclOutsideAfter -cne $emptyAclOutsideBefore) {
    throw "Empty workspace-link allowlist did not safely reject an undeclared junction."
  }
  Remove-Item -LiteralPath $emptyAclUndeclaredJunction -Force
  $emptyAclProtectionReceipt = Protect-ReleaseDirectory `
    -Layout $layout `
    -ReleaseRoot $emptyAclProtectionRoot `
    -IdentitySid $emptyAclIdentitySid `
    -CriticalPaths @($emptyAclCriticalPaths) `
    -WorkspaceLinks @()
  [void](Assert-ProtectedAclContract `
      -Path $emptyAclProtectionRoot `
      -IdentitySid $emptyAclIdentitySid `
      -IdentityAccess ReadAndExecute `
      -DescendantAclMode Explicit `
      -Recursive)
  if ([int]$emptyAclProtectionReceipt.entryCount -lt 6 -or
      [int]$emptyAclProtectionReceipt.reparsePointCount -ne 0 -or
      [string]$emptyAclProtectionReceipt.inventorySha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [int64]$emptyAclProtectionReceipt.elapsedMilliseconds -lt 1) {
    throw "Zero-link release ACL worker did not return its bounded evidence receipt."
  }
} finally {
  if (Test-Path -LiteralPath $emptyAclUndeclaredJunction) {
    $emptyAclUndeclaredJunctionItem = Get-Item -LiteralPath $emptyAclUndeclaredJunction -Force
    if (($emptyAclUndeclaredJunctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
      throw "Zero-link ACL hardening fixture cleanup found a non-reparse replacement path."
    }
    Remove-Item -LiteralPath $emptyAclUndeclaredJunction -Force
  }
  if (Test-Path -LiteralPath $emptyAclProtectionRoot -PathType Container) {
    [void](Assert-ContainedPath -Root $layout.Releases -Path $emptyAclProtectionRoot)
    $cleanupSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $cleanupOutput = & $script:CanonicalIcaclsPath `
      $emptyAclProtectionRoot `
      "/inheritance:e" `
      "/grant:r" `
      "*$($cleanupSid):(OI)(CI)F" `
      "/T" `
      "/C" `
      "/Q" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to reopen the zero-link ACL hardening fixture: $($cleanupOutput -join [Environment]::NewLine)"
    }
    Remove-Item -LiteralPath $emptyAclProtectionRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $emptyAclOutsideRoot -PathType Container) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $emptyAclOutsideRoot)
    Remove-Item -LiteralPath $emptyAclOutsideRoot -Recurse -Force
  }
}
$aclProtectionRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "acl-protection-test-$([guid]::NewGuid().ToString('N'))")
$aclOutsideRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "acl-outside-test-$([guid]::NewGuid().ToString('N'))")
$aclProtectionReceipt = $null
$staleReparseSwapRejected = $false
$hardLinkRejected = $false
$invalidAclContainmentRejected = $false
$invalidAclRootNameRejected = $false
try {
  foreach ($directory in @(
      (Join-Path $aclProtectionRoot "apps\api\nested"),
      (Join-Path $aclProtectionRoot "node_modules\@unified-ai"),
      (Join-Path $aclProtectionRoot "node_modules\plain")
    )) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $aclProtectionRoot "apps\api\nested\index.js"),
    "workspace`n"
  )
  [void](New-Item -ItemType Directory -Path $aclOutsideRoot)
  [System.IO.File]::WriteAllText((Join-Path $aclOutsideRoot "outside.txt"), "outside`n")
  $outsideAclBefore = (Get-Acl -LiteralPath $aclOutsideRoot).Sddl
  $staleEntryPath = Join-Path $aclProtectionRoot "stale-entry"
  [void](New-Item -ItemType Directory -Path $staleEntryPath)
  Initialize-NativeReparsePointAcl
  $staleEntryIdentity = [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::Inspect($staleEntryPath)
  Remove-Item -LiteralPath $staleEntryPath -Force
  [void](New-Item -ItemType Junction -Path $staleEntryPath -Target $aclOutsideRoot)
  try {
    [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::SetAndVerifyPath(
      $staleEntryPath,
      [string]$identity.identitySid,
      $true,
      $false,
      $true,
      [string]$staleEntryIdentity.StableId
    )
  } catch {
    $staleReparseSwapRejected = $true
  }
  $outsideAclAfter = (Get-Acl -LiteralPath $aclOutsideRoot).Sddl
  if (-not $staleReparseSwapRejected -or $outsideAclAfter -cne $outsideAclBefore) {
    throw "Stale release metadata redirected an ACL write through a replacement junction."
  }
  Remove-Item -LiteralPath $staleEntryPath -Force

  $hardLinkSource = Join-Path $aclProtectionRoot "node_modules\plain\hard-link-source.txt"
  $hardLinkAlias = Join-Path $aclProtectionRoot "node_modules\plain\hard-link-alias.txt"
  [System.IO.File]::WriteAllText($hardLinkSource, "hard-link`n")
  [void](New-Item -ItemType HardLink -Path $hardLinkAlias -Target $hardLinkSource)
  try {
    [void][UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::Inspect($hardLinkSource)
  } catch {
    $hardLinkRejected = $true
  }
  Remove-Item -LiteralPath $hardLinkAlias -Force
  Remove-Item -LiteralPath $hardLinkSource -Force
  if (-not $hardLinkRejected) {
    throw "Release ACL inspection accepted a multi-link regular file."
  }

  try {
    Invoke-ReleaseTreeAclWorker `
      -ContainmentRoot $layout.State `
      -ReleaseRoot (Join-Path $layout.State "acl-invalid") `
      -IdentitySid ([string]$identity.identitySid) `
      -AllowedWorkspaceLinksBase64 "W10="
  } catch {
    $invalidAclContainmentRejected = $true
  }
  try {
    Invoke-ReleaseTreeAclWorker `
      -ContainmentRoot $layout.Staging `
      -ReleaseRoot $aclOutsideRoot `
      -IdentitySid ([string]$identity.identitySid) `
      -AllowedWorkspaceLinksBase64 "W10="
  } catch {
    $invalidAclRootNameRejected = $true
  }
  if (-not $invalidAclContainmentRejected -or -not $invalidAclRootNameRejected) {
    throw "Release ACL worker accepted an unapproved containment root or root name."
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $aclProtectionRoot "node_modules\plain\index.js"),
    "dependency`n"
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $aclProtectionRoot "node_modules\plain\.hidden"),
    "hidden`n"
  )
  [void](New-Item `
      -ItemType Junction `
      -Path (Join-Path $aclProtectionRoot "node_modules\@unified-ai\api") `
      -Target (Join-Path $aclProtectionRoot "apps\api"))
  $aclIdentitySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $aclProtectionReceipt = Invoke-ReleaseTreeAclProtectionProcess `
    -ContainmentRoot $layout.Staging `
    -ReleaseRoot $aclProtectionRoot `
    -IdentitySid $aclIdentitySid `
    -WorkspaceLinks @([ordered]@{
        linkPath = "node_modules/@unified-ai/api"
        targetRelativePath = "apps/api"
      }) `
    -TimeoutSeconds 120
  [void](Assert-ProtectedAclContract `
      -Path $aclProtectionRoot `
      -IdentitySid $aclIdentitySid `
      -IdentityAccess ReadAndExecute `
      -DescendantAclMode Explicit `
      -Recursive)
  Initialize-NativeReparsePointAcl
  [UnifiedAiOrchestratorDeployment.NativeReparsePointAcl]::Verify(
    (Join-Path $aclProtectionRoot "node_modules\@unified-ai\api"),
    $aclIdentitySid
  )
  if ([int]$aclProtectionReceipt.entryCount -lt 9 -or
      [int]$aclProtectionReceipt.reparsePointCount -ne 1 -or
      [string]$aclProtectionReceipt.inventorySha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [int64]$aclProtectionReceipt.elapsedMilliseconds -lt 1) {
    throw "Explicit-entry release ACL worker did not return its bounded evidence receipt."
  }
} finally {
  if (Test-Path -LiteralPath $aclProtectionRoot -PathType Container) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $aclProtectionRoot)
    $cleanupSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $cleanupOutput = & $script:CanonicalIcaclsPath `
      $aclProtectionRoot `
      "/inheritance:e" `
      "/grant:r" `
      "*$($cleanupSid):(OI)(CI)F" `
      "/T" `
      "/C" `
      "/Q" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to reopen the bounded ACL hardening fixture: $($cleanupOutput -join [Environment]::NewLine)"
    }
    Remove-Item -LiteralPath $aclProtectionRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $aclOutsideRoot -PathType Container) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $aclOutsideRoot)
    $cleanupSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    [void](& $script:CanonicalIcaclsPath `
        $aclOutsideRoot `
        "/inheritance:e" `
        "/grant:r" `
        "*$($cleanupSid):(OI)(CI)F" `
        "/T" `
        "/C" `
        "/Q" 2>&1)
    Remove-Item -LiteralPath $aclOutsideRoot -Recurse -Force
  }
}

$testRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "hardening-test-$([guid]::NewGuid().ToString('N'))")
try {
  [void](New-Item -ItemType Directory -Path (Join-Path $testRoot "node_modules\@unified-ai") -Force)
  [void](New-Item -ItemType Directory -Path (Join-Path $testRoot "node_modules\plain") -Force)
  [void](New-Item -ItemType Directory -Path (Join-Path $testRoot "apps\api\node_modules\nested") -Force)
  [System.IO.File]::WriteAllText((Join-Path $testRoot "node_modules\plain\index.js"), "baseline`n")
  [System.IO.File]::WriteAllText((Join-Path $testRoot "node_modules\plain\keep.js"), "keep`n")
  [System.IO.File]::WriteAllText((Join-Path $testRoot "apps\api\node_modules\nested\index.js"), "nested-baseline`n")
  $packageLock = [ordered]@{
    lockfileVersion = 3
    packages = [ordered]@{
      "" = [ordered]@{ name = "hardening-test" }
      "node_modules/@unified-ai/api" = [ordered]@{ resolved = "apps/api"; link = $true }
    }
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $testRoot "package-lock.json"),
    ($packageLock | ConvertTo-Json -Depth 10)
  )
  [void](New-Item `
      -ItemType Junction `
      -Path (Join-Path $testRoot "node_modules\@unified-ai\api") `
      -Target (Join-Path $testRoot "apps\api"))

  $baselineTree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $testRoot -ExpectedSha ("a" * 40)
  [System.IO.File]::WriteAllText((Join-Path $testRoot "apps\api\node_modules\nested\index.js"), "nested-modified`n")
  $nestedModifiedTree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $testRoot -ExpectedSha ("a" * 40)
  if ([string]$nestedModifiedTree.treeSha256 -ceq [string]$baselineTree.treeSha256) {
    throw "Runtime tree hash did not reject a modified workspace-local dependency."
  }
  [System.IO.File]::WriteAllText((Join-Path $testRoot "node_modules\plain\index.js"), "modified`n")
  $modifiedTree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $testRoot -ExpectedSha ("a" * 40)
  if ([string]$modifiedTree.treeSha256 -ceq [string]$baselineTree.treeSha256) {
    throw "Runtime tree hash did not reject a modified file."
  }
  [System.IO.File]::WriteAllText((Join-Path $testRoot "node_modules\plain\added.js"), "added`n")
  $addedTree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $testRoot -ExpectedSha ("a" * 40)
  if ([int]$addedTree.entryCount -le [int]$modifiedTree.entryCount) {
    throw "Runtime tree inventory did not detect an added file."
  }
  Remove-Item -LiteralPath (Join-Path $testRoot "node_modules\plain\added.js") -Force
  Remove-Item -LiteralPath (Join-Path $testRoot "node_modules\plain\index.js") -Force
  $deletedTree = Get-RuntimeDependencyTreeReceipt -ReleaseRoot $testRoot -ExpectedSha ("a" * 40)
  if ([int]$deletedTree.entryCount -ge [int]$modifiedTree.entryCount) {
    throw "Runtime tree inventory did not detect a deleted file."
  }

  Remove-Item -LiteralPath (Join-Path $testRoot "node_modules\@unified-ai\api") -Force
  [void](New-Item `
      -ItemType Junction `
      -Path (Join-Path $testRoot "node_modules\@unified-ai\api") `
      -Target $env:TEMP)
  $outsideRejected = $false
  try {
    [void](Get-RuntimeDependencyTreeReceipt -ReleaseRoot $testRoot -ExpectedSha ("a" * 40))
  } catch {
    $outsideRejected = $true
  }
  if (-not $outsideRejected) {
    throw "Runtime tree inventory accepted an outside-root junction."
  }
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $testRoot)
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}

$stateTestRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "state-recovery-test-$([guid]::NewGuid().ToString('N'))")
$stateFixture = [ordered]@{
  Root = $stateTestRoot
  Backups = Join-Path $stateTestRoot "backups"
  Current = Join-Path $stateTestRoot "current.json"
  Previous = Join-Path $stateTestRoot "previous.json"
  Pending = Join-Path $stateTestRoot "pending.json"
  Process = Join-Path $stateTestRoot "state\process.json"
  LastKnownGoodController = Join-Path $stateTestRoot "state\last-known-good-controller.json"
  ControllerInstallation = Join-Path $stateTestRoot "state\recovery-controller-installation.json"
  TaskInstallation = Join-Path $stateTestRoot "state\local-production-task-installation.json"
  Logs = Join-Path $stateTestRoot "logs"
  Events = Join-Path $stateTestRoot "logs\deployment-events.jsonl"
}
try {
  [void](New-Item -ItemType Directory -Path $stateFixture.Backups -Force)
  [void](New-Item -ItemType Directory -Path (Join-Path $stateTestRoot "state") -Force)
  $expectedProcessReceipt = [ordered]@{
    schemaVersion = 2
    commitSha = "6" * 40
    pid = 4242
    entrypoint = Join-Path $stateTestRoot "release\server.bundle.mjs"
    nodePath = "C:\reviewed\node.exe"
    nodeVersion = "v22.23.2"
    nodeSha256 = "a" * 64
    runtimeDependencyReceiptSha256 = "b" * 64
    startedAtUtc = "2026-08-30T12:00:00.0000000+00:00"
    stdoutPath = Join-Path $stateFixture.Logs "stdout.log"
    stderrPath = Join-Path $stateFixture.Logs "stderr.log"
    supervised = $true
  }
  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.Process -Value $expectedProcessReceipt
  if (Remove-MatchingReleaseProcessReceipt `
      -Layout $stateFixture `
      -ExpectedReceipt $expectedProcessReceipt `
      -ChildConfirmedExited $false) {
    throw "Process receipt cleanup removed a receipt without confirmed child exit."
  }
  if (-not (Test-Path -LiteralPath $stateFixture.Process -PathType Leaf)) {
    throw "Process receipt cleanup lost a live-child receipt."
  }

  $replacementProcessReceipt = [ordered]@{}
  foreach ($entry in $expectedProcessReceipt.GetEnumerator()) {
    $replacementProcessReceipt[[string]$entry.Key] = $entry.Value
  }
  $replacementProcessReceipt.startedAtUtc = "2026-08-30T12:00:01.0000000+00:00"
  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.Process -Value $replacementProcessReceipt
  if (Remove-MatchingReleaseProcessReceipt `
      -Layout $stateFixture `
      -ExpectedReceipt $expectedProcessReceipt `
      -ChildConfirmedExited $true) {
    throw "Process receipt cleanup removed a replacement process receipt."
  }
  $retainedReplacement = Read-JsonHashtable -Path $stateFixture.Process
  if ([string]$retainedReplacement.startedAtUtc -cne [string]$replacementProcessReceipt.startedAtUtc) {
    throw "Process receipt cleanup changed a replacement process receipt."
  }

  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.Process -Value $expectedProcessReceipt
  $outerReceiptMutex = Enter-DeploymentMutex
  try {
    if (-not (Remove-MatchingReleaseProcessReceipt `
          -Layout $stateFixture `
          -ExpectedReceipt $expectedProcessReceipt `
          -ChildConfirmedExited $true)) {
      throw "Process receipt cleanup retained an exact exited-child receipt."
    }
  } finally {
    Exit-DeploymentMutex -Mutex $outerReceiptMutex
  }
  if (Test-Path -LiteralPath $stateFixture.Process) {
    throw "Process receipt cleanup did not remove the exact exited-child receipt."
  }

  $startupDiagnosticPath = Join-Path $stateFixture.Logs "diagnostic-fixture\startup-diagnostic.json"
  Write-StartupDiagnostic `
    -Layout $stateFixture `
    -Path $startupDiagnosticPath `
    -CommitSha ("6" * 40) `
    -RunId "20260830T120000Z-123456789abc" `
    -ProcessId 4242 `
    -Phase "failed" `
    -PreCleanupState "running" `
    -PostCleanupState "exited" `
    -ExitCode 37 `
    -FailureMessage ("x" * 700) `
    -StdoutPath ([string]$expectedProcessReceipt.stdoutPath) `
    -StderrPath ([string]$expectedProcessReceipt.stderrPath) `
    -Supervised $true
  $startupDiagnostic = Read-JsonHashtable -Path $startupDiagnosticPath
  if ([int]$startupDiagnostic.schemaVersion -ne 1 -or
      [string]$startupDiagnostic.phase -cne "failed" -or
      [string]$startupDiagnostic.preCleanupState -cne "running" -or
      [string]$startupDiagnostic.postCleanupState -cne "exited" -or
      [int]$startupDiagnostic.exitCode -ne 37 -or
      ([string]$startupDiagnostic.failureMessage).Length -ne 500 -or
      @(
        Get-ChildItem -LiteralPath (Split-Path -Parent $startupDiagnosticPath) -Force |
          Where-Object { $_.Name -like ".startup-diagnostic.json.*.tmp" }
      ).Count -ne 0) {
    throw "Startup diagnostic did not persist the bounded atomic failure contract."
  }

  Write-DeploymentEvent `
    -Layout $stateFixture `
    -Action "deploy" `
    -Status "started" `
    -CommitSha ("6" * 40) `
    -OperationId "20260830T120000Z-123456789abc" `
    -Message "Deployment event JSON Lines fixture started."
  Write-DeploymentEvent `
    -Layout $stateFixture `
    -Action "deploy" `
    -Status "succeeded" `
    -CommitSha ("6" * 40) `
    -OperationId "20260830T120000Z-123456789abc" `
    -Message ("x" * 700)
  $deploymentEventLines = @(Get-Content -LiteralPath $stateFixture.Events)
  if ($deploymentEventLines.Count -ne 2) {
    throw "Deployment event log did not write exactly one JSON object per line."
  }
  $startedEvent = ConvertFrom-DeploymentJsonHashtable -Json $deploymentEventLines[0]
  $succeededEvent = ConvertFrom-DeploymentJsonHashtable -Json $deploymentEventLines[1]
  if ([int]$startedEvent.schemaVersion -ne 1 -or
      [string]$startedEvent.action -cne "deploy" -or
      [string]$startedEvent.status -cne "started" -or
      [string]$startedEvent.commitSha -cne ("6" * 40) -or
      [string]$startedEvent.operationId -cne "20260830T120000Z-123456789abc" -or
      [string]$startedEvent.message -cne "Deployment event JSON Lines fixture started." -or
      [string]$succeededEvent.status -cne "succeeded" -or
      ([string]$succeededEvent.message).Length -ne 500) {
    throw "Deployment event log did not preserve its bounded JSON Lines contract."
  }
  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.Current -Value ([ordered]@{ marker = "current-before" })
  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.LastKnownGoodController -Value ([ordered]@{ marker = "controller-before" })
  $currentSnapshot = Read-OptionalJsonState -Layout $stateFixture -Path $stateFixture.Current
  $previousSnapshot = Read-OptionalJsonState -Layout $stateFixture -Path $stateFixture.Previous
  $controllerSnapshot = Read-OptionalJsonState -Layout $stateFixture -Path $stateFixture.LastKnownGoodController
  $backupRoot = Backup-DeploymentState -Layout $stateFixture -OperationId (Get-OperationId)
  $backup = Read-JsonHashtable -Path (Join-Path $backupRoot "backup.json")
  if ([int]$backup.schemaVersion -ne 3 -or
      -not [bool]$backup.entries["current.json"].present -or
      [bool]$backup.entries["previous.json"].present -or
      -not [bool]$backup.entries["last-known-good-controller.json"].present) {
    throw "Activation-state backup did not preserve exact state-file presence."
  }
  $backupManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $backupRoot "backup.json") -Algorithm SHA256).Hash.ToLowerInvariant()
  [void](Read-DeploymentStateBackup `
      -Layout $stateFixture `
      -OperationId ([string]$backup.operationId) `
      -ExpectedManifestSha256 $backupManifestSha256)
  $backupCurrentPath = Join-Path $backupRoot "current.json"
  $backupCurrentOriginal = Get-Content -LiteralPath $backupCurrentPath -Raw
  [System.IO.File]::AppendAllText($backupCurrentPath, "tamper")
  $tamperedBackupRejected = $false
  try {
    [void](Read-DeploymentStateBackup `
        -Layout $stateFixture `
        -OperationId ([string]$backup.operationId) `
        -ExpectedManifestSha256 $backupManifestSha256)
  } catch {
    $tamperedBackupRejected = $true
  }
  [System.IO.File]::WriteAllText($backupCurrentPath, $backupCurrentOriginal, [System.Text.UTF8Encoding]::new($false))
  if (-not $tamperedBackupRejected) {
    throw "Activation-state backup accepted a tampered state file."
  }
  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.Current -Value ([ordered]@{ marker = "current-after" })
  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.Previous -Value ([ordered]@{ marker = "unexpected-previous" })
  Write-AtomicJson -Layout $stateFixture -Path $stateFixture.LastKnownGoodController -Value ([ordered]@{ marker = "controller-after" })
  Restore-OptionalJsonState -Layout $stateFixture -Path $stateFixture.Current -Snapshot $currentSnapshot
  Restore-OptionalJsonState -Layout $stateFixture -Path $stateFixture.Previous -Snapshot $previousSnapshot
  Restore-OptionalJsonState -Layout $stateFixture -Path $stateFixture.LastKnownGoodController -Snapshot $controllerSnapshot
  $restoredCurrent = Read-JsonHashtable -Path $stateFixture.Current
  $restoredController = Read-JsonHashtable -Path $stateFixture.LastKnownGoodController
  if ([string]$restoredCurrent.marker -cne "current-before" -or
      (Test-Path -LiteralPath $stateFixture.Previous -PathType Leaf) -or
      [string]$restoredController.marker -cne "controller-before") {
    throw "Activation-state restoration did not reproduce the exact pre-failure state."
  }
  $invalidSnapshotRejected = $false
  try {
    Restore-OptionalJsonState `
      -Layout $stateFixture `
      -Path $stateFixture.Previous `
      -Snapshot ([ordered]@{ present = $true; value = "not-an-object" })
  } catch {
    $invalidSnapshotRejected = $true
  }
  if (-not $invalidSnapshotRejected) {
    throw "Activation-state restoration accepted an invalid snapshot."
  }
} finally {
  if (Test-Path -LiteralPath $stateTestRoot) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $stateTestRoot)
    Remove-Item -LiteralPath $stateTestRoot -Recurse -Force
  }
}

$earlyExitProbe = $null
$hangingListener = $null
$hangingConnection = $null
$earlyExitTimer = [System.Diagnostics.Stopwatch]::StartNew()
$earlyExitRejected = $false
$earlyExitMessage = ""
try {
  $hangingListener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  $hangingListener.Start()
  $hangingPort = ([System.Net.IPEndPoint]$hangingListener.LocalEndpoint).Port
  $hangingConnection = $hangingListener.AcceptTcpClientAsync()
  $earlyExitProbe = Start-Process `
    -FilePath (Get-StableExecutable -Name "pwsh.exe") `
    -ArgumentList @(
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Sleep -Milliseconds 250; exit 37"
    ) `
    -WindowStyle Hidden `
    -PassThru
  try {
    [void](Invoke-ObservedReleaseJsonRequest `
        -Uri "http://127.0.0.1:$hangingPort/never-responds" `
        -ObservedProcess $earlyExitProbe `
        -RequestTimeoutMilliseconds 5000)
  } catch {
    $earlyExitRejected = $true
    $earlyExitMessage = $_.Exception.Message
  }
} finally {
  $earlyExitTimer.Stop()
  if ($null -ne $earlyExitProbe -and -not $earlyExitProbe.HasExited) {
    Stop-Process -Id $earlyExitProbe.Id -Force -ErrorAction SilentlyContinue
    [void]$earlyExitProbe.WaitForExit(10000)
  }
  if ($null -ne $hangingListener) {
    $hangingListener.Stop()
  }
  if ($null -ne $hangingConnection -and $hangingConnection.IsCompletedSuccessfully) {
    $hangingConnection.Result.Dispose()
  }
}
if (-not $earlyExitRejected -or
    $earlyExitMessage -cne "Release process exited before health succeeded with code 37." -or
    $earlyExitTimer.Elapsed.TotalSeconds -ge 5) {
  throw "Observed early process exit was not classified quickly with its exact exit code: $earlyExitMessage"
}

$installRecoveryRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "release-install-recovery-test-$([guid]::NewGuid().ToString('N'))")
$installRecoveryLayout = [ordered]@{
  Root = $installRecoveryRoot
  Releases = Join-Path $installRecoveryRoot "releases"
  Staging = Join-Path $installRecoveryRoot "staging"
  Failed = Join-Path $installRecoveryRoot "failed"
  State = Join-Path $installRecoveryRoot "state"
  Current = Join-Path $installRecoveryRoot "current.json"
  Previous = Join-Path $installRecoveryRoot "previous.json"
  Pending = Join-Path $installRecoveryRoot "pending.json"
  ReleaseInstallationPending = Join-Path $installRecoveryRoot "state\release-installation-pending.json"
  Process = Join-Path $installRecoveryRoot "state\process.json"
  LastKnownGoodController = Join-Path $installRecoveryRoot "state\last-known-good-controller.json"
  RuntimeIntegrity = Join-Path $installRecoveryRoot "state\runtime-dependencies"
  Events = Join-Path $installRecoveryRoot "logs\deployment-events.jsonl"
}
try {
  foreach ($directory in @(
      $installRecoveryLayout.Releases,
      $installRecoveryLayout.Staging,
      $installRecoveryLayout.Failed,
      $installRecoveryLayout.State,
      $installRecoveryLayout.RuntimeIntegrity,
      (Split-Path -Parent $installRecoveryLayout.Events)
    )) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
  }
  $installSha = "b" * 40
  $installOperationId = Get-OperationId
  $installStagingRoot = Join-Path $installRecoveryLayout.Staging "$installSha-$installOperationId"
  $installReleaseRoot = Join-Path $installRecoveryLayout.Releases $installSha
  [void](New-Item -ItemType Directory -Path $installStagingRoot)
  [System.IO.File]::WriteAllText((Join-Path $installStagingRoot "partial.txt"), "partial")
  Write-AtomicJson `
    -Layout $installRecoveryLayout `
    -Path $installRecoveryLayout.ReleaseInstallationPending `
    -Value ([ordered]@{
        schemaVersion = 1
        commitSha = $installSha
        operationId = $installOperationId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        state = "installing"
        artifactSha256 = "a" * 64
        releaseRoot = $installReleaseRoot
        stagingRoot = $installStagingRoot
      })
  $installRecovery = Recover-InterruptedReleaseInstallation -Layout $installRecoveryLayout
  if ([bool]$installRecovery.completed -or
      (Test-Path -LiteralPath $installStagingRoot) -or
      -not (Test-Path -LiteralPath ([string]$installRecovery.recoveryRecord) -PathType Leaf) -or
      @($installRecovery.quarantined).Count -ne 1) {
    throw "Staging-only interrupted release installation was not quarantined exactly."
  }

  $unreferencedSha = "9" * 40
  $unreferencedOperationId = Get-OperationId
  $unreferencedReleaseRoot = Join-Path $installRecoveryLayout.Releases $unreferencedSha
  $unreferencedStagingRoot = Join-Path $installRecoveryLayout.Staging "$unreferencedSha-$unreferencedOperationId"
  [void](New-Item -ItemType Directory -Path $unreferencedReleaseRoot)
  [System.IO.File]::WriteAllText((Join-Path $unreferencedReleaseRoot "partial.txt"), "partial")
  Write-AtomicJson `
    -Layout $installRecoveryLayout `
    -Path $installRecoveryLayout.ReleaseInstallationPending `
    -Value ([ordered]@{
        schemaVersion = 1
        commitSha = $unreferencedSha
        operationId = $unreferencedOperationId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        state = "installing"
        artifactSha256 = "8" * 64
        releaseRoot = $unreferencedReleaseRoot
        stagingRoot = $unreferencedStagingRoot
      })
  $unreferencedRecovery = Recover-InterruptedReleaseInstallation -Layout $installRecoveryLayout
  if ([bool]$unreferencedRecovery.completed -or
      (Test-Path -LiteralPath $unreferencedReleaseRoot) -or
      @($unreferencedRecovery.quarantined).Count -ne 1) {
    throw "Unreferenced incomplete final release was not quarantined exactly."
  }

  $referencedSha = "c" * 40
  $referencedOperationId = Get-OperationId
  $referencedReleaseRoot = Join-Path $installRecoveryLayout.Releases $referencedSha
  $referencedStagingRoot = Join-Path $installRecoveryLayout.Staging "$referencedSha-$referencedOperationId"
  [void](New-Item -ItemType Directory -Path $referencedReleaseRoot)
  Write-AtomicJson `
    -Layout $installRecoveryLayout `
    -Path $installRecoveryLayout.Current `
    -Value (New-ReleasePointer `
      -CommitSha $referencedSha `
      -Reason "hardening-fixture" `
      -RuntimeDependencyReceiptSha256 ("d" * 64))
  Write-AtomicJson `
    -Layout $installRecoveryLayout `
    -Path $installRecoveryLayout.ReleaseInstallationPending `
    -Value ([ordered]@{
        schemaVersion = 1
        commitSha = $referencedSha
        operationId = $referencedOperationId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        state = "installing"
        artifactSha256 = "e" * 64
        releaseRoot = $referencedReleaseRoot
        stagingRoot = $referencedStagingRoot
      })
  $referencedInstallRejected = $false
  try {
    [void](Recover-InterruptedReleaseInstallation -Layout $installRecoveryLayout)
  } catch {
    $referencedInstallRejected = $true
  }
  if (-not $referencedInstallRejected -or
      -not (Test-Path -LiteralPath $referencedReleaseRoot -PathType Container) -or
      -not (Test-Path -LiteralPath $installRecoveryLayout.ReleaseInstallationPending -PathType Leaf)) {
    throw "Referenced incomplete release installation did not fail closed."
  }

  Remove-Item -LiteralPath $installRecoveryLayout.Current -Force
  Remove-Item -LiteralPath $installRecoveryLayout.ReleaseInstallationPending -Force
  Remove-Item -LiteralPath $referencedReleaseRoot -Force
  $ambiguousSha = "f" * 40
  $ambiguousOperationId = Get-OperationId
  Write-AtomicJson -Layout $installRecoveryLayout -Path $installRecoveryLayout.Pending -Value ([ordered]@{ marker = "activation" })
  Write-AtomicJson `
    -Layout $installRecoveryLayout `
    -Path $installRecoveryLayout.ReleaseInstallationPending `
    -Value ([ordered]@{
        schemaVersion = 1
        commitSha = $ambiguousSha
        operationId = $ambiguousOperationId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        state = "installing"
        artifactSha256 = "1" * 64
        releaseRoot = (Join-Path $installRecoveryLayout.Releases $ambiguousSha)
        stagingRoot = (Join-Path $installRecoveryLayout.Staging "$ambiguousSha-$ambiguousOperationId")
      })
  $ambiguousPendingRejected = $false
  try {
    [void](Recover-InterruptedReleaseInstallation -Layout $installRecoveryLayout)
  } catch {
    $ambiguousPendingRejected = $true
  }
  if (-not $ambiguousPendingRejected) {
    throw "Simultaneous install and activation pending records were incorrectly accepted."
  }
} finally {
  if (Test-Path -LiteralPath $installRecoveryRoot) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $installRecoveryRoot)
    Remove-Item -LiteralPath $installRecoveryRoot -Recurse -Force
  }
}

[ordered]@{
  accepted = $true
  boundedProcessTreeTermination = $true
  boundedProcessIdleWatchdog = $true
  abandonedMutexRecoveries = 2
  scheduledTaskMutationsRejected = $mutations.Count
  unsafeWindowsPayloadPathsRejected = $unsafePayloadPaths.Count
  jsonTimestampStringPreserved = $true
  nestedReparseQuarantineRejected = $true
  crossTransactionPendingRejected = $true
  releaseEntrypointSchemasVerified = 4
  controllerVersion = [string]$controllerReceipt.controllerVersion
  controllerManifestSha256 = [string]$controllerReceipt.controllerManifestSha256
  nodeRuntimeVersion = [string]$nodeRuntime.version
  nodeRuntimeFileCount = [int]$nodeRuntime.payloadFileCount
  nodeRuntimeTreeSha256 = [string]$nodeRuntime.payloadTreeSha256
  nodeRuntimeVerificationMilliseconds = [int64]$nodeRuntimeTimer.ElapsedMilliseconds
  runtimeTreeFaultsRejected = 5
  emptyWorkspaceLinkReleaseAclEntries = [int]$emptyAclProtectionReceipt.entryCount
  emptyWorkspaceLinkReleaseAclReparsePoints = [int]$emptyAclProtectionReceipt.reparsePointCount
  emptyWorkspaceLinkReleaseAclInventorySha256 = [string]$emptyAclProtectionReceipt.inventorySha256
  emptyWorkspaceLinkUndeclaredJunctionRejected = $emptyAclUndeclaredJunctionRejected
  explicitReleaseAclEntries = [int]$aclProtectionReceipt.entryCount
  explicitReleaseAclReparsePoints = [int]$aclProtectionReceipt.reparsePointCount
  explicitReleaseAclInventorySha256 = [string]$aclProtectionReceipt.inventorySha256
  explicitReleaseAclElapsedMilliseconds = [int64]$aclProtectionReceipt.elapsedMilliseconds
  staleReparseSwapRejected = $staleReparseSwapRejected
  hardLinkReleaseEntryRejected = $hardLinkRejected
  aclContainmentContractsRejected = 2
  activationStateFaultsRejected = 5
  processReceiptCleanupCases = 3
  startupDiagnosticFailureMessageCharacters = 500
  earlyExitHangingEndpoint = $true
  earlyExitProcessCode = 37
  earlyExitDetectionMilliseconds = [int64]$earlyExitTimer.ElapsedMilliseconds
  releaseInstallationRecoveryFaultsRejected = 4
} | ConvertTo-Json -Depth 10
