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
$powerShellPath = Get-StableExecutable -Name "pwsh.exe"
$expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"C:\reviewed\Start.ps1`""

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
}
try {
  [void](New-Item -ItemType Directory -Path $stateFixture.Backups -Force)
  [void](New-Item -ItemType Directory -Path (Join-Path $stateTestRoot "state") -Force)
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
  abandonedMutexRecoveries = 2
  scheduledTaskMutationsRejected = $mutations.Count
  unsafeWindowsPayloadPathsRejected = $unsafePayloadPaths.Count
  jsonTimestampStringPreserved = $true
  nestedReparseQuarantineRejected = $true
  crossTransactionPendingRejected = $true
  controllerVersion = [string]$controllerReceipt.controllerVersion
  controllerManifestSha256 = [string]$controllerReceipt.controllerManifestSha256
  nodeRuntimeVersion = [string]$nodeRuntime.version
  nodeRuntimeFileCount = [int]$nodeRuntime.payloadFileCount
  nodeRuntimeTreeSha256 = [string]$nodeRuntime.payloadTreeSha256
  nodeRuntimeVerificationMilliseconds = [int64]$nodeRuntimeTimer.ElapsedMilliseconds
  runtimeTreeFaultsRejected = 5
  activationStateFaultsRejected = 5
  releaseInstallationRecoveryFaultsRejected = 4
} | ConvertTo-Json -Depth 10
