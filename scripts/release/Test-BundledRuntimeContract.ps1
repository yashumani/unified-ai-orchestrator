#requires -Version 7.4

[CmdletBinding()]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
. (Join-Path $resolvedRoot "scripts\deployment\Deployment.Common.ps1")

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
)
$harnessRoot = Join-Path $temporaryRoot "unified-ai-bundle-contract-$([guid]::NewGuid().ToString('N'))"
$bundleContent = [System.Text.UTF8Encoding]::new($false).GetBytes("export const ready = true;`n")
$bundleHash = [Convert]::ToHexString(
  [System.Security.Cryptography.SHA256]::HashData($bundleContent)
).ToLowerInvariant()
$binary = if ([System.OperatingSystem]::IsWindows()) {
  [ordered]@{
    packageName = "@esbuild/win32-x64"
    integrity = "sha512-5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g=="
    platform = "win32"
  }
} elseif ([System.OperatingSystem]::IsLinux()) {
  [ordered]@{
    packageName = "@esbuild/linux-x64"
    integrity = "sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ=="
    platform = "linux"
  }
} else {
  throw "Bundled runtime contract tests support only reviewed Windows x64 and Linux x64 builders."
}

function Get-ReceiptPath {
  param([Parameter(Mandatory)][string]$Root)
  return (Join-Path $Root "apps\api\dist\server.bundle.json")
}

function Write-Receipt {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Receipt
  )
  [System.IO.File]::WriteAllText(
    (Get-ReceiptPath -Root $Root),
    "$(ConvertTo-Json -InputObject $Receipt -Depth 8)`n",
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Read-FixtureReceipt {
  param([Parameter(Mandatory)][string]$Root)
  return ((Get-Content -LiteralPath (Get-ReceiptPath -Root $Root) -Raw) |
      ConvertFrom-Json -AsHashtable -Depth 8)
}

function New-ValidFixture {
  param([Parameter(Mandatory)][string]$Name)

  $root = Join-Path $harnessRoot $Name
  $dist = Join-Path $root "apps\api\dist"
  [void](New-Item -ItemType Directory -Path $dist -Force)
  Copy-Item -LiteralPath (Join-Path $resolvedRoot "package-lock.json") -Destination (Join-Path $root "package-lock.json")
  [System.IO.File]::WriteAllBytes((Join-Path $dist "server.bundle.mjs"), $bundleContent)
  Write-Receipt -Root $root -Receipt ([ordered]@{
      schemaVersion = 2
      buildKind = "esbuild-bundle-v1"
      builder = "esbuild"
      builderVersion = "0.28.2"
      builderPackageIntegrity = "sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA=="
      builderBinaryPackage = [string]$binary.packageName
      builderBinaryIntegrity = [string]$binary.integrity
      entrypoint = "apps/api/dist/server.js"
      output = "apps/api/dist/server.bundle.mjs"
      platform = "node"
      format = "esm"
      target = "node22"
      nodeVersion = "v22.23.2"
      buildPlatform = [string]$binary.platform
      buildArchitecture = "x64"
      requireBridge = "node-builtins-only-require-v1"
      runtimeFeatureGuard = "copilotkit-channels-disabled-v1"
      runtimeResolutionGuard = "node-builtins-only-v1"
      bundleSha256 = $bundleHash
      bundleBytes = [uint64]$bundleContent.Length
    })
  return $root
}

$rejectedCases = [System.Collections.Generic.List[string]]::new()
function Assert-RejectedFixture {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Mutate
  )

  $root = New-ValidFixture -Name $Name
  & $Mutate $root
  $accepted = $false
  try {
    [void](Read-BundledRuntimeBuildReceipt -ReleaseRoot $root)
    $accepted = $true
  } catch {
    $rejectedCases.Add($Name)
  }
  if ($accepted) {
    throw "Bundled runtime negative contract case was accepted: $Name"
  }
}

try {
  [void](New-Item -ItemType Directory -Path $harnessRoot)
  $validRoot = New-ValidFixture -Name "valid"
  $valid = Read-BundledRuntimeBuildReceipt -ReleaseRoot $validRoot
  if ([string]$valid.bundleSha256 -cne $bundleHash -or
      [uint64]$valid.bundleBytes -ne [uint64]$bundleContent.Length) {
    throw "Valid bundled runtime fixture returned the wrong identity."
  }

  Assert-RejectedFixture -Name "missing-key" -Mutate {
    param($root)
    $receipt = Read-FixtureReceipt -Root $root
    [void]$receipt.Remove("target")
    Write-Receipt -Root $root -Receipt $receipt
  }
  Assert-RejectedFixture -Name "extra-key" -Mutate {
    param($root)
    $receipt = Read-FixtureReceipt -Root $root
    $receipt["unexpected"] = "rejected"
    Write-Receipt -Root $root -Receipt $receipt
  }
  Assert-RejectedFixture -Name "duplicate-key" -Mutate {
    param($root)
    $path = Get-ReceiptPath -Root $root
    $raw = (Get-Content -LiteralPath $path -Raw).TrimEnd()
    [System.IO.File]::WriteAllText(
      $path,
      "$($raw.Substring(0, $raw.Length - 1)),`"schemaVersion`":2}`n",
      [System.Text.UTF8Encoding]::new($false)
    )
  }
  Assert-RejectedFixture -Name "case-colliding-key" -Mutate {
    param($root)
    $path = Get-ReceiptPath -Root $root
    $raw = (Get-Content -LiteralPath $path -Raw).TrimEnd()
    [System.IO.File]::WriteAllText(
      $path,
      "$($raw.Substring(0, $raw.Length - 1)),`"SchemaVersion`":2}`n",
      [System.Text.UTF8Encoding]::new($false)
    )
  }
  Assert-RejectedFixture -Name "string-schema" -Mutate {
    param($root)
    $receipt = Read-FixtureReceipt -Root $root
    $receipt.schemaVersion = "2"
    Write-Receipt -Root $root -Receipt $receipt
  }
  Assert-RejectedFixture -Name "boolean-bundle-bytes" -Mutate {
    param($root)
    $receipt = Read-FixtureReceipt -Root $root
    $receipt.bundleBytes = $true
    Write-Receipt -Root $root -Receipt $receipt
  }
  Assert-RejectedFixture -Name "fractional-bundle-bytes" -Mutate {
    param($root)
    $receipt = Read-FixtureReceipt -Root $root
    $receipt.bundleBytes = [double]1.5
    Write-Receipt -Root $root -Receipt $receipt
  }
  Assert-RejectedFixture -Name "malformed-json" -Mutate {
    param($root)
    [System.IO.File]::WriteAllText((Get-ReceiptPath -Root $root), "{", [System.Text.UTF8Encoding]::new($false))
  }
  Assert-RejectedFixture -Name "oversized-receipt" -Mutate {
    param($root)
    [System.IO.File]::WriteAllText(
      (Get-ReceiptPath -Root $root),
      (" " * 65537),
      [System.Text.UTF8Encoding]::new($false)
    )
  }
  Assert-RejectedFixture -Name "bundle-hash-mismatch" -Mutate {
    param($root)
    $receipt = Read-FixtureReceipt -Root $root
    $receipt.bundleSha256 = "0" * 64
    Write-Receipt -Root $root -Receipt $receipt
  }
  Assert-RejectedFixture -Name "bundle-length-mismatch" -Mutate {
    param($root)
    $receipt = Read-FixtureReceipt -Root $root
    $receipt.bundleBytes = [uint64]$receipt.bundleBytes + 1
    Write-Receipt -Root $root -Receipt $receipt
  }
  Assert-RejectedFixture -Name "selected-binary-lock-mismatch" -Mutate {
    param($root)
    $lockPath = Join-Path $root "package-lock.json"
    $lock = (Get-Content -LiteralPath $lockPath -Raw) | ConvertFrom-Json -AsHashtable -Depth 100
    $lock.packages["node_modules/$([string]$binary.packageName)"].integrity = "sha512-rejected"
    [System.IO.File]::WriteAllText(
      $lockPath,
      "$(ConvertTo-Json -InputObject $lock -Depth 100)`n",
      [System.Text.UTF8Encoding]::new($false)
    )
  }

  $reparseRoot = New-ValidFixture -Name "reparse-ancestor"
  $externalApps = Join-Path $harnessRoot "reparse-external-apps"
  Move-Item -LiteralPath (Join-Path $reparseRoot "apps") -Destination $externalApps
  $appsLink = Join-Path $reparseRoot "apps"
  if ([System.OperatingSystem]::IsWindows()) {
    [void](New-Item -ItemType Junction -Path $appsLink -Target $externalApps)
  } else {
    [void](New-Item -ItemType SymbolicLink -Path $appsLink -Target $externalApps)
  }
  $reparseAccepted = $false
  try {
    [void](Read-BundledRuntimeBuildReceipt -ReleaseRoot $reparseRoot)
    $reparseAccepted = $true
  } catch {
    $rejectedCases.Add("reparse-ancestor")
  } finally {
    if (Test-Path -LiteralPath $appsLink) {
      Remove-Item -LiteralPath $appsLink -Force
    }
  }
  if ($reparseAccepted) {
    throw "Bundled runtime negative contract case was accepted: reparse-ancestor"
  }

  [ordered]@{
    accepted = $true
    validCases = 1
    rejectedCases = $rejectedCases.Count
    rejectedCaseNames = @($rejectedCases)
  } | ConvertTo-Json -Compress
} finally {
  $resolvedHarness = [System.IO.Path]::GetFullPath($harnessRoot)
  $expectedPrefix = "$temporaryRoot$([System.IO.Path]::DirectorySeparatorChar)unified-ai-bundle-contract-"
  if ((Test-Path -LiteralPath $resolvedHarness) -and
      $resolvedHarness.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedHarness -Recurse -Force
  }
}
