#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
$archivePath = Get-PinnedNodeArchivePath -Layout $layout
$identity = Get-CurrentWindowsIdentityReceipt

function New-NodeRuntimeInstallationState {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Runtime)

  return [ordered]@{
    schemaVersion = 1
    version = $script:PinnedNodeVersion
    archiveSha256 = $script:PinnedNodeArchiveSha256
    payloadFileCount = [int]$Runtime.fileCount
    payloadTreeSha256 = [string]$Runtime.treeSha256
    runtimeRoot = $layout.NodeRuntimeRoot
    nodePath = [string]$Runtime.nodePath
    npmPath = [string]$Runtime.npmPath
    identityName = [string]$identity.identityName
    identitySid = [string]$identity.identitySid
    installedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  }
}

function Read-NodeRuntimeInstallationPending {
  $pending = Read-JsonHashtable -Path $layout.NodeRuntimeInstallationPending
  $requiredKeys = @(
    "schemaVersion", "operationId", "version", "archiveSha256", "stagingRoot",
    "runtimeRoot", "createdAtUtc", "state"
  )
  if (@($pending.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { $_ -notin $pending.Keys }).Count -ne 0 -or
      [int]$pending.schemaVersion -ne 1 -or
      [string]$pending.operationId -notmatch "^[0-9TZ-]+-[0-9a-f]{12}$" -or
      [string]$pending.version -cne $script:PinnedNodeVersion -or
      [string]$pending.archiveSha256 -cne $script:PinnedNodeArchiveSha256 -or
      [string]$pending.state -cne "installing") {
    throw "Pending Node.js runtime installation record is invalid."
  }
  [void](Assert-UtcTimestamp -Value ([string]$pending.createdAtUtc) -Context "Pending Node.js runtime createdAtUtc")
  $expectedStagingRoot = Assert-ContainedPath `
    -Root $layout.Staging `
    -Path (Join-Path $layout.Staging "node-runtime-$([string]$pending.operationId)")
  foreach ($comparison in @(
      @([string]$pending.stagingRoot, $expectedStagingRoot),
      @([string]$pending.runtimeRoot, $layout.NodeRuntimeRoot)
    )) {
    if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath($comparison[0]),
        [System.IO.Path]::GetFullPath($comparison[1]),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Pending Node.js runtime installation references an unexpected path."
    }
  }
  return $pending
}

function Move-NodeRuntimeRecoveryPath {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$AllowedRoot
  )

  if (-not (Test-Path -LiteralPath $Source)) {
    return $null
  }
  [void](Assert-ContainedPath -Root $AllowedRoot -Path $Source)
  [void](Assert-TreeContainsNoReparsePoints -Root $Source)
  $item = Get-Item -LiteralPath $Source -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Interrupted Node.js runtime path is a reparse point: $Source"
  }
  $destination = Assert-ContainedPath -Root $layout.Failed -Path (Join-Path $layout.Failed $Name)
  if (Test-Path -LiteralPath $destination) {
    throw "Node.js runtime recovery target already exists: $destination"
  }
  Move-Item -LiteralPath $Source -Destination $destination
  return $destination
}

function Recover-InterruptedNodeRuntimeInstallation {
  if (-not (Test-Path -LiteralPath $layout.NodeRuntimeInstallationPending -PathType Leaf)) {
    return $null
  }
  $pending = Read-NodeRuntimeInstallationPending
  $operationId = [string]$pending.operationId
  $completed = $false
  $qualified = $null
  if (Test-Path -LiteralPath $layout.NodeRuntimeRoot -PathType Container) {
    try {
      $runtime = Test-PinnedNodeRuntime `
        -Layout $layout `
        -RuntimeRoot $layout.NodeRuntimeRoot `
        -ExecuteVersionChecks
      [void](Protect-PinnedNodeRuntime -Layout $layout -IdentitySid ([string]$identity.identitySid))
      $runtime = Test-PinnedNodeRuntime `
        -Layout $layout `
        -RuntimeRoot $layout.NodeRuntimeRoot `
        -ExpectedFileCount ([int]$runtime.fileCount) `
        -ExpectedTreeSha256 ([string]$runtime.treeSha256) `
        -ExecuteVersionChecks
      Write-AtomicJson `
        -Layout $layout `
        -Path $layout.NodeRuntimeInstallation `
        -Value (New-NodeRuntimeInstallationState -Runtime $runtime)
      $qualified = Read-PinnedNodeRuntimeInstallation -Layout $layout -ExecuteVersionChecks
      $completed = $true
    } catch {
      $completed = $false
    }
  }
  if (-not $completed -and
      -not (Test-Path -LiteralPath $layout.NodeRuntimeRoot) -and
      (Test-Path -LiteralPath ([string]$pending.stagingRoot) -PathType Container)) {
    try {
      $runtime = Test-PinnedNodeRuntime `
        -Layout $layout `
        -RuntimeRoot ([string]$pending.stagingRoot) `
        -ExecuteVersionChecks
      Move-Item -LiteralPath ([string]$pending.stagingRoot) -Destination $layout.NodeRuntimeRoot
      [void](Protect-PinnedNodeRuntime -Layout $layout -IdentitySid ([string]$identity.identitySid))
      $runtime = Test-PinnedNodeRuntime `
        -Layout $layout `
        -RuntimeRoot $layout.NodeRuntimeRoot `
        -ExpectedFileCount ([int]$runtime.fileCount) `
        -ExpectedTreeSha256 ([string]$runtime.treeSha256) `
        -ExecuteVersionChecks
      Write-AtomicJson `
        -Layout $layout `
        -Path $layout.NodeRuntimeInstallation `
        -Value (New-NodeRuntimeInstallationState -Runtime $runtime)
      $qualified = Read-PinnedNodeRuntimeInstallation -Layout $layout -ExecuteVersionChecks
      $completed = $true
    } catch {
      $completed = $false
    }
  }
  $quarantined = [System.Collections.Generic.List[string]]::new()
  if (-not $completed) {
    $failedRuntime = Move-NodeRuntimeRecoveryPath `
      -Source $layout.NodeRuntimeRoot `
      -Name "node-runtime-$operationId-final" `
      -AllowedRoot $layout.Toolchains
    if ($null -ne $failedRuntime) {
      $quarantined.Add($failedRuntime)
    }
    if (Test-Path -LiteralPath $layout.NodeRuntimeInstallation -PathType Leaf) {
      $failedState = Assert-ContainedPath `
        -Root $layout.Failed `
        -Path (Join-Path $layout.Failed "node-runtime-$operationId-state.json")
      Move-Item -LiteralPath $layout.NodeRuntimeInstallation -Destination $failedState
      $quarantined.Add($failedState)
    }
  }
  $failedStaging = Move-NodeRuntimeRecoveryPath `
    -Source ([string]$pending.stagingRoot) `
    -Name "node-runtime-$operationId-staging" `
    -AllowedRoot $layout.Staging
  if ($null -ne $failedStaging) {
    $quarantined.Add($failedStaging)
  }
  $recoveryRecord = Assert-ContainedPath `
    -Root $layout.Failed `
    -Path (Join-Path $layout.Failed "node-runtime-$operationId-recovered.json")
  Move-Item -LiteralPath $layout.NodeRuntimeInstallationPending -Destination $recoveryRecord
  try {
    Write-DeploymentEvent `
      -Layout $layout `
      -Action "node-runtime-installation-recovery" `
      -Status "succeeded" `
      -OperationId $operationId `
      -Message $(if ($completed) {
          "Completed an interrupted byte-verified Node.js runtime installation."
        } else {
          "Quarantined an interrupted incomplete Node.js runtime installation."
        })
  } catch {
    Write-Warning "Node-runtime recovery committed but event logging failed: $($_.Exception.Message)"
  }
  return [ordered]@{
    completed = $completed
    qualified = $qualified
    quarantined = @($quarantined)
    recoveryRecord = $recoveryRecord
  }
}

if (-not $PSCmdlet.ShouldProcess(
    $layout.NodeRuntimeRoot,
    "Install and seal the official hash-pinned Node.js $script:PinnedNodeVersion runtime on the D-backed deployment path"
  )) {
  [ordered]@{
    whatIf = $true
    version = $script:PinnedNodeVersion
    archiveUrl = $script:PinnedNodeArchiveUrl
    archiveSha256 = $script:PinnedNodeArchiveSha256
    archivePath = $archivePath
    runtimeRoot = $layout.NodeRuntimeRoot
    statePath = $layout.NodeRuntimeInstallation
  } | ConvertTo-Json -Depth 10
  return
}

Initialize-DeploymentLayout -Layout $layout
$transaction = Enter-DeploymentTransactionMutex
$stagingRoot = $null
$temporaryArchive = $null
try {
  if ([bool]$transaction.WasAbandoned) {
    Assert-NoDeploymentReparsePoints -Layout $layout
    Write-DeploymentEvent -Layout $layout -Action "lock-recovery" -Status "info" -Message "Recovered an abandoned Node-runtime installation mutex after revalidating deployment paths."
  }
  $deploymentRecoveryPending = (
    (Test-Path -LiteralPath $layout.Pending -PathType Leaf) -or
    (Test-Path -LiteralPath $layout.ReleaseInstallationPending -PathType Leaf)
  )
  if ($deploymentRecoveryPending) {
    Assert-NoDeploymentReparsePoints -Layout $layout
    Assert-NoForeignDeploymentPendingRecords `
      -Layout $layout `
      -AllowedPaths @($layout.Pending, $layout.ReleaseInstallationPending)
    [void](Recover-InterruptedDeploymentActivation `
        -Layout $layout `
        -RepositoryRoot $RepositoryRoot `
        -TaskName $script:CanonicalTaskName `
        -HealthUri $script:CanonicalHealthUri `
        -HealthTimeoutSeconds 180)
    [void](Recover-InterruptedReleaseInstallation -Layout $layout)
  }
  Assert-NoForeignDeploymentPendingRecords `
    -Layout $layout `
    -AllowedPaths @($layout.NodeRuntimeInstallationPending)
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    Write-Host "[node-runtime] Verifying the cached official Node.js archive."
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveHash -cne $script:PinnedNodeArchiveSha256) {
      throw "Existing Node.js archive hash is invalid; refusing to overwrite it automatically."
    }
  } else {
    Write-Host "[node-runtime] Downloading the official Node.js archive."
    $temporaryArchive = Assert-ContainedPath `
      -Root $layout.Downloads `
      -Path "$archivePath.$([guid]::NewGuid().ToString('N')).download"
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
      Invoke-WebRequest `
        -Uri $script:PinnedNodeArchiveUrl `
        -OutFile $temporaryArchive `
        -MaximumRedirection 5
    } finally {
      $ProgressPreference = $oldProgress
    }
    $archiveHash = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveHash -cne $script:PinnedNodeArchiveSha256) {
      throw "Downloaded Node.js archive SHA-256 does not match the reviewed official checksum."
    }
    [System.IO.File]::Move($temporaryArchive, $archivePath, $false)
    $temporaryArchive = $null
  }

  [void](Recover-InterruptedNodeRuntimeInstallation)
  if (Test-Path -LiteralPath $layout.NodeRuntimeInstallation -PathType Leaf) {
    Write-Host "[node-runtime] Revalidating the existing D-backed Node.js installation."
    $existing = Read-PinnedNodeRuntimeInstallation -Layout $layout -ExecuteVersionChecks
    [ordered]@{
      installed = $true
      reused = $true
      version = [string]$existing.version
      archiveSha256 = [string]$existing.archiveSha256
      payloadFileCount = [int]$existing.payloadFileCount
      payloadTreeSha256 = [string]$existing.payloadTreeSha256
      runtimeRoot = [string]$existing.runtimeRoot
      nodePath = [string]$existing.nodePath
      npmPath = [string]$existing.npmPath
    } | ConvertTo-Json -Depth 10
    return
  }
  if (Test-Path -LiteralPath $layout.NodeRuntimeRoot) {
    throw "Pinned Node.js runtime exists without installation state or a recoverable pending record."
  }

  $operationId = Get-OperationId
  $stagingRoot = Assert-ContainedPath `
    -Root $layout.Staging `
    -Path (Join-Path $layout.Staging "node-runtime-$operationId")
  Write-AtomicJson -Layout $layout -Path $layout.NodeRuntimeInstallationPending -Value ([ordered]@{
      schemaVersion = 1
      operationId = $operationId
      version = $script:PinnedNodeVersion
      archiveSha256 = $script:PinnedNodeArchiveSha256
      stagingRoot = $stagingRoot
      runtimeRoot = $layout.NodeRuntimeRoot
      createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
      state = "installing"
    })
  [void](New-Item -ItemType Directory -Path $stagingRoot)
  Write-Host "[node-runtime] Extracting the pinned Node.js archive into contained staging."
  Expand-PinnedNodeArchive -Layout $layout -ArchivePath $archivePath -DestinationRoot $stagingRoot
  Write-Host "[node-runtime] Comparing the staged distribution byte for byte with the official archive."
  $staged = Test-PinnedNodeRuntime `
    -Layout $layout `
    -RuntimeRoot $stagingRoot `
    -ExecuteVersionChecks
  Move-Item -LiteralPath $stagingRoot -Destination $layout.NodeRuntimeRoot
  $stagingRoot = $null
  Write-Host "[node-runtime] Sealing the D-backed distribution with the reviewed recursive ACL."
  [void](Protect-PinnedNodeRuntime -Layout $layout -IdentitySid ([string]$identity.identitySid))
  Write-Host "[node-runtime] Revalidating the sealed D-backed distribution."
  $installed = Test-PinnedNodeRuntime `
    -Layout $layout `
    -RuntimeRoot $layout.NodeRuntimeRoot `
    -ExpectedFileCount ([int]$staged.fileCount) `
    -ExpectedTreeSha256 ([string]$staged.treeSha256) `
    -ExecuteVersionChecks
  $state = New-NodeRuntimeInstallationState -Runtime $installed
  Write-AtomicJson -Layout $layout -Path $layout.NodeRuntimeInstallation -Value $state
  $qualified = Read-PinnedNodeRuntimeInstallation -Layout $layout -ExecuteVersionChecks
  Remove-Item -LiteralPath $layout.NodeRuntimeInstallationPending -Force
  Write-DeploymentEvent -Layout $layout -Action "install-node-runtime" -Status "succeeded" -Message "Installed official Node.js $script:PinnedNodeVersion on the D-backed deployment path with byte-for-byte archive verification."
  [ordered]@{
    installed = $true
    reused = $false
    version = [string]$qualified.version
    archiveSha256 = [string]$qualified.archiveSha256
    payloadFileCount = [int]$qualified.payloadFileCount
    payloadTreeSha256 = [string]$qualified.payloadTreeSha256
    runtimeRoot = [string]$qualified.runtimeRoot
    nodePath = [string]$qualified.nodePath
    npmPath = [string]$qualified.npmPath
  } | ConvertTo-Json -Depth 10
} catch {
  $failure = $_.Exception.Message
  if (Test-Path -LiteralPath $layout.NodeRuntimeInstallationPending -PathType Leaf) {
    try {
      [void](Recover-InterruptedNodeRuntimeInstallation)
    } catch {
      $failure = "$failure Node-runtime recovery also failed: $($_.Exception.Message)"
    }
  }
  throw $failure
} finally {
  if ($null -ne $temporaryArchive -and (Test-Path -LiteralPath $temporaryArchive)) {
    [void](Assert-ContainedPath -Root $layout.Downloads -Path $temporaryArchive)
    Remove-Item -LiteralPath $temporaryArchive -Force
  }
  Exit-DeploymentMutex -Mutex $transaction
}
