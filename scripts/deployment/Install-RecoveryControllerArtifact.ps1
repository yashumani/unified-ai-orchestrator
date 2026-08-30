#requires -Version 7.4

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory)][string]$ArtifactPath,
  [Parameter(Mandatory)][string]$ChecksumPath,
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$ArtifactPath = [System.IO.Path]::GetFullPath($ArtifactPath)
$ChecksumPath = [System.IO.Path]::GetFullPath($ChecksumPath)
foreach ($path in @($ArtifactPath, $ChecksumPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Recovery controller artifact input is missing: $path"
  }
}
$checksumLine = (Get-Content -LiteralPath $ChecksumPath -Raw).Trim()
if ($checksumLine -cnotmatch "^(?<hash>[0-9a-f]{64})  (?<name>[A-Za-z0-9._-]+\.zip)$" -or
    $Matches.name -cne [System.IO.Path]::GetFileName($ArtifactPath)) {
  throw "Recovery controller checksum sidecar is invalid."
}
$actualHash = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -cne $Matches.hash) {
  throw "Recovery controller artifact SHA-256 mismatch."
}

$layout = Get-DeploymentLayout -RepositoryRoot $RepositoryRoot
if (-not $PSCmdlet.ShouldProcess(
    $layout.Controllers,
    "Extract, verify, install, and seal the published recovery controller artifact"
  )) {
  [ordered]@{
    whatIf = $true
    artifactPath = $ArtifactPath
    artifactSha256 = $actualHash
    controllerRoot = $layout.Controllers
  } | ConvertTo-Json -Depth 10
  return
}

Initialize-DeploymentLayout -Layout $layout
$stagingRoot = Assert-ContainedPath `
  -Root $layout.Staging `
  -Path (Join-Path $layout.Staging "controller-artifact-$([guid]::NewGuid().ToString('N'))")
[void](New-Item -ItemType Directory -Path $stagingRoot)
try {
  Add-Type -AssemblyName System.IO.Compression
  $requiredNames = @(
    "Deployment.Common.ps1",
    "Start-LocalRelease.ps1",
    "Stop-LocalRelease.ps1",
    "Rollback-LocalRelease.ps1",
    "Test-LocalRelease.ps1",
    "Test-LocalAiRuntime.ps1",
    "controller-manifest.json"
  )
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArtifactPath)
  try {
    $entries = @($archive.Entries)
    $names = @($entries | ForEach-Object { $_.FullName })
    if ($entries.Count -ne $requiredNames.Count -or
        @($names | Where-Object { $_ -notin $requiredNames }).Count -ne 0 -or
        @($requiredNames | Where-Object { $_ -notin $names }).Count -ne 0 -or
        @($names | Group-Object | Where-Object Count -ne 1).Count -ne 0) {
      throw "Recovery controller artifact must contain exactly the seven reviewed flat files."
    }
    foreach ($entry in $entries) {
      if ($entry.Name -cne $entry.FullName -or $entry.Name -cnotmatch "^[A-Za-z0-9.-]+$") {
        throw "Recovery controller artifact contains an unsafe path."
      }
      $target = Assert-ContainedPath -Root $stagingRoot -Path (Join-Path $stagingRoot $entry.Name)
      $input = $entry.Open()
      try {
        $output = [System.IO.File]::Open(
          $target,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None
        )
        try {
          $input.CopyTo($output)
        } finally {
          $output.Dispose()
        }
      } finally {
        $input.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }

  $sourceReceipt = Test-RecoveryControllerManifest -Layout $layout -SourceRoot $stagingRoot
  $installOutput = & (Join-Path $PSScriptRoot "Install-RecoveryController.ps1") `
    -RepositoryRoot $RepositoryRoot `
    -SourceRoot $stagingRoot `
    -Confirm:$false
  $installOutput = $null
  $identity = Get-CurrentWindowsIdentityReceipt
  $controllerRoot = Get-RecoveryControllerRoot `
    -Layout $layout `
    -ControllerVersion ([string]$sourceReceipt.controllerVersion) `
    -ControllerManifestSha256 ([string]$sourceReceipt.controllerManifestSha256)
  [void](Test-InstalledRecoveryController `
      -Layout $layout `
      -ControllerRoot $controllerRoot `
      -ExpectedManifestSha256 ([string]$sourceReceipt.controllerManifestSha256) `
      -IdentitySid ([string]$identity.identitySid))
  [ordered]@{
    schemaVersion = 1
    controllerVersion = [string]$sourceReceipt.controllerVersion
    controllerManifestSha256 = [string]$sourceReceipt.controllerManifestSha256
    controllerRoot = $controllerRoot
    identityName = [string]$identity.identityName
    identitySid = [string]$identity.identitySid
    installedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  } | ConvertTo-Json -Depth 10
} finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    [void](Assert-ContainedPath -Root $layout.Staging -Path $stagingRoot)
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
