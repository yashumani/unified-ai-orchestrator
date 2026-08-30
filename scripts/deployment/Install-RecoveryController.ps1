#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [string]$SourceRoot = $PSScriptRoot
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
$sourceReceipt = Test-RecoveryControllerManifest -Layout $layout -SourceRoot $SourceRoot
$identity = Get-CurrentWindowsIdentityReceipt
$controllerRoot = Get-RecoveryControllerRoot `
  -Layout $layout `
  -ControllerVersion ([string]$sourceReceipt.controllerVersion) `
  -ControllerManifestSha256 ([string]$sourceReceipt.controllerManifestSha256)

function Read-RecoveryControllerInstallationPending {
  $pending = Read-JsonHashtable -Path $layout.ControllerInstallationPending
  $requiredKeys = @(
    "schemaVersion", "operationId", "controllerVersion", "controllerManifestSha256",
    "controllerRoot", "stagingRoot", "identitySid", "createdAtUtc", "state"
  )
  if (@($pending.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $pending.Keys }).Count -ne 0 -or
      [int]$pending.schemaVersion -ne 1 -or
      [string]$pending.operationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      [string]$pending.controllerManifestSha256 -cnotmatch "^[0-9a-f]{64}$" -or
      [string]$pending.identitySid -cnotmatch "^S-1-[0-9-]+$" -or
      [string]$pending.state -cne "installing") {
    throw "Pending recovery-controller installation record is invalid."
  }
  [void](Assert-SupportedControllerVersion -ControllerVersion ([string]$pending.controllerVersion))
  [void](Assert-UtcTimestamp -Value ([string]$pending.createdAtUtc) -Context "Pending recovery controller createdAtUtc")
  $expectedControllerRoot = Get-RecoveryControllerRoot `
    -Layout $layout `
    -ControllerVersion ([string]$pending.controllerVersion) `
    -ControllerManifestSha256 ([string]$pending.controllerManifestSha256)
  $expectedStagingRoot = Assert-ContainedPath `
    -Root $layout.Controllers `
    -Path (Join-Path $layout.Controllers ".install-$([string]$pending.operationId)")
  foreach ($comparison in @(
      @([string]$pending.controllerRoot, $expectedControllerRoot),
      @([string]$pending.stagingRoot, $expectedStagingRoot)
    )) {
    if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath($comparison[0]),
        [System.IO.Path]::GetFullPath($comparison[1]),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Pending recovery-controller installation references an unexpected path."
    }
  }
  return $pending
}

function Assert-RecoveryControllerInstallIsUnreferenced {
  param([Parameter(Mandatory)][string]$CandidateRoot)

  $references = [System.Collections.Generic.List[object]]::new()
  if (Test-Path -LiteralPath $layout.ControllerInstallation -PathType Leaf) {
    $state = Read-RecoveryControllerInstallation -Layout $layout
    $references.Add([pscustomobject]@{
        path = $layout.ControllerInstallation
        root = [string]$state.controllerRoot
      })
  }
  if (Test-Path -LiteralPath $layout.TaskInstallation -PathType Leaf) {
    $state = Read-DeploymentTaskInstallation -Layout $layout
    $references.Add([pscustomobject]@{
        path = $layout.TaskInstallation
        root = Split-Path -Parent ([string]$state.startScript)
      })
  }
  if (Test-Path -LiteralPath $layout.LastKnownGoodController -PathType Leaf) {
    $state = Read-LastKnownGoodRecoveryController -Layout $layout
    $references.Add([pscustomobject]@{
        path = $layout.LastKnownGoodController
        root = [string]$state.controllerRoot
      })
  }
  foreach ($reference in $references) {
    if ([string]::Equals(
        [System.IO.Path]::GetFullPath([string]$reference.root),
        [System.IO.Path]::GetFullPath($CandidateRoot),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Interrupted recovery-controller installation is still referenced by $([string]$reference.path)."
    }
  }
}

function Move-RecoveryControllerInstallPathToFailed {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Name
  )

  if (-not (Test-Path -LiteralPath $Source)) {
    return $null
  }
  [void](Assert-ContainedPath -Root $layout.Controllers -Path $Source)
  [void](Assert-TreeContainsNoReparsePoints -Root $Source)
  $item = Get-Item -LiteralPath $Source -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Interrupted recovery-controller installation path is a reparse point: $Source"
  }
  $destination = Assert-ContainedPath -Root $layout.Failed -Path (Join-Path $layout.Failed $Name)
  if (Test-Path -LiteralPath $destination) {
    throw "Recovery-controller quarantine target already exists: $destination"
  }
  Move-Item -LiteralPath $Source -Destination $destination
  return $destination
}

function Recover-InterruptedRecoveryControllerInstallation {
  if (-not (Test-Path -LiteralPath $layout.ControllerInstallationPending -PathType Leaf)) {
    return $null
  }
  if (Test-Path -LiteralPath $layout.ControllerActivationPending -PathType Leaf) {
    throw "Controller installation and activation pending records coexist; refusing ambiguous recovery."
  }
  $pending = Read-RecoveryControllerInstallationPending
  $candidateRoot = [string]$pending.controllerRoot
  $operationId = [string]$pending.operationId
  $completed = $false
  if (Test-Path -LiteralPath $candidateRoot -PathType Container) {
    try {
      [void](Test-InstalledRecoveryController `
          -Layout $layout `
          -ControllerRoot $candidateRoot `
          -ExpectedManifestSha256 ([string]$pending.controllerManifestSha256) `
          -IdentitySid ([string]$pending.identitySid) `
          -ExpectedControllerVersion ([string]$pending.controllerVersion))
      $completed = $true
    } catch {
      $completed = $false
    }
  }
  $quarantined = [System.Collections.Generic.List[string]]::new()
  if (-not $completed) {
    Assert-RecoveryControllerInstallIsUnreferenced -CandidateRoot $candidateRoot
    $failedController = Move-RecoveryControllerInstallPathToFailed `
      -Source $candidateRoot `
      -Name "controller-$operationId-final"
    if ($null -ne $failedController) {
      $quarantined.Add($failedController)
    }
  }
  $failedStaging = Move-RecoveryControllerInstallPathToFailed `
    -Source ([string]$pending.stagingRoot) `
    -Name "controller-$operationId-staging"
  if ($null -ne $failedStaging) {
    $quarantined.Add($failedStaging)
  }
  $recoveryRecord = Assert-ContainedPath `
    -Root $layout.Failed `
    -Path (Join-Path $layout.Failed "controller-$operationId-recovered.json")
  Move-Item -LiteralPath $layout.ControllerInstallationPending -Destination $recoveryRecord
  try {
    Write-DeploymentEvent `
      -Layout $layout `
      -Action "controller-installation-recovery" `
      -Status "succeeded" `
      -OperationId $operationId `
      -Message $(if ($completed) {
          "Recovered a fully sealed interrupted recovery-controller installation."
        } else {
          "Quarantined an incomplete interrupted recovery-controller installation."
        })
  } catch {
    Write-Warning "Recovery-controller installation recovery committed but event logging failed: $($_.Exception.Message)"
  }
  return [ordered]@{
    completed = $completed
    controllerRoot = $candidateRoot
    quarantined = @($quarantined)
    recoveryRecord = $recoveryRecord
  }
}

if (-not $PSCmdlet.ShouldProcess(
    $controllerRoot,
    "Install and seal the hash-verified out-of-band recovery controller"
  )) {
  [ordered]@{
    whatIf = $true
    controllerVersion = [string]$sourceReceipt.controllerVersion
    controllerManifestSha256 = [string]$sourceReceipt.controllerManifestSha256
    controllerRoot = $controllerRoot
    identitySid = [string]$identity.identitySid
  } | ConvertTo-Json -Depth 10
  return
}

Initialize-DeploymentLayout -Layout $layout
$transaction = Enter-DeploymentTransactionMutex
$operationId = Get-OperationId
$stagingRoot = Assert-ContainedPath `
  -Root $layout.Controllers `
  -Path (Join-Path $layout.Controllers ".install-$operationId")
try {
  if ([bool]$transaction.WasAbandoned) {
    Assert-NoDeploymentReparsePoints -Layout $layout
    Write-DeploymentEvent -Layout $layout -Action "lock-recovery" -Status "info" -Message "Recovered an abandoned recovery-controller installation mutex after revalidating deployment paths."
  }
  Assert-NoForeignDeploymentPendingRecords `
    -Layout $layout `
    -AllowedPaths @($layout.ControllerInstallationPending)
  [void](Recover-InterruptedRecoveryControllerInstallation)
  if (Test-Path -LiteralPath $controllerRoot -PathType Container) {
    [void](Test-InstalledRecoveryController `
        -Layout $layout `
        -ControllerRoot $controllerRoot `
        -ExpectedManifestSha256 ([string]$sourceReceipt.controllerManifestSha256) `
        -IdentitySid ([string]$identity.identitySid))
  } else {
    Write-AtomicJson -Layout $layout -Path $layout.ControllerInstallationPending -Value ([ordered]@{
        schemaVersion = 1
        operationId = $operationId
        controllerVersion = [string]$sourceReceipt.controllerVersion
        controllerManifestSha256 = [string]$sourceReceipt.controllerManifestSha256
        controllerRoot = $controllerRoot
        stagingRoot = $stagingRoot
        identitySid = [string]$identity.identitySid
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        state = "installing"
      })
    [void](New-Item -ItemType Directory -Path $stagingRoot)
    foreach ($name in @($sourceReceipt.files.Keys) + @("controller-manifest.json")) {
      Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination (Join-Path $stagingRoot $name)
    }
    $stagedReceipt = Test-RecoveryControllerManifest -Layout $layout -SourceRoot $stagingRoot
    if ([string]$stagedReceipt.controllerManifestSha256 -cne [string]$sourceReceipt.controllerManifestSha256) {
      throw "Staged recovery controller does not match the reviewed source bundle."
    }
    Move-Item -LiteralPath $stagingRoot -Destination $controllerRoot
    $aclOutput = & $script:CanonicalIcaclsPath $controllerRoot /reset /T /C /Q 2>&1
    if ($LASTEXITCODE -eq 0) {
      $aclOutput += & $script:CanonicalIcaclsPath $controllerRoot /inheritance:r /grant:r "*$([string]$identity.identitySid):(OI)(CI)RX" "*S-1-5-18:(OI)(CI)F" /Q 2>&1
    }
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to seal recovery controller read-only: $($aclOutput -join [Environment]::NewLine)"
    }
    [void](Test-InstalledRecoveryController `
        -Layout $layout `
        -ControllerRoot $controllerRoot `
        -ExpectedManifestSha256 ([string]$sourceReceipt.controllerManifestSha256) `
        -IdentitySid ([string]$identity.identitySid))
    Remove-Item -LiteralPath $layout.ControllerInstallationPending -Force
  }

  $state = [ordered]@{
    schemaVersion = 1
    controllerVersion = [string]$sourceReceipt.controllerVersion
    controllerManifestSha256 = [string]$sourceReceipt.controllerManifestSha256
    controllerRoot = $controllerRoot
    identityName = [string]$identity.identityName
    identitySid = [string]$identity.identitySid
    installedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-DeploymentEvent -Layout $layout -Action "stage-recovery-controller" -Status "succeeded" -Message "Staged hash-verified recovery controller $($sourceReceipt.controllerVersion) without changing the active task controller."
  $state | ConvertTo-Json -Depth 10
} catch {
  $failure = $_.Exception.Message
  if (Test-Path -LiteralPath $layout.ControllerInstallationPending -PathType Leaf) {
    try {
      [void](Recover-InterruptedRecoveryControllerInstallation)
    } catch {
      $failure = "$failure Recovery-controller installation recovery also failed: $($_.Exception.Message)"
    }
  }
  throw $failure
} finally {
  Exit-DeploymentMutex -Mutex $transaction
}
