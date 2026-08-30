#requires -Version 7.4

[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern("^[0-9a-f]{40}$")][string]$CommitSha,
  [Parameter(Mandatory)][string]$OutputPath,
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-GitText {
  param([Parameter(Mandatory)][string[]]$Arguments)
  $output = & git -C $RepositoryRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return (($output -join "`n").Trim())
}

$resolvedRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path.TrimEnd("\", "/")
if ((Invoke-GitText -Arguments @("rev-parse", "HEAD")) -cne $CommitSha) {
  throw "Recovery controller packaging requires the exact repository HEAD."
}
if ((Invoke-GitText -Arguments @("status", "--porcelain=v1", "--untracked-files=all")).Length -ne 0) {
  throw "Recovery controller packaging requires a clean repository."
}

$controllerSource = Join-Path $resolvedRoot "scripts\deployment"
. (Join-Path $controllerSource "Deployment.Common.ps1")
$layout = Get-DeploymentLayout -RepositoryRoot $resolvedRoot
$receipt = Test-RecoveryControllerManifest -Layout $layout -SourceRoot $controllerSource
$timestamp = [DateTimeOffset]::Parse(
  (Invoke-GitText -Arguments @("show", "-s", "--format=%cI", $CommitSha))
).ToUniversalTime()
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
[void](New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedOutput) -Force)
if (Test-Path -LiteralPath $resolvedOutput) {
  Remove-Item -LiteralPath $resolvedOutput -Force
}

Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open(
  $resolvedOutput,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::None
)
try {
  $archive = [System.IO.Compression.ZipArchive]::new(
    $stream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  try {
    $names = @($receipt.files.Keys) + @("controller-manifest.json") | Sort-Object
    foreach ($name in $names) {
      $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = $timestamp
      $input = [System.IO.File]::OpenRead((Join-Path $controllerSource $name))
      try {
        $output = $entry.Open()
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
} finally {
  $stream.Dispose()
}

$artifactSha256 = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(
  "$resolvedOutput.sha256",
  "$artifactSha256  $([System.IO.Path]::GetFileName($resolvedOutput))`n",
  [System.Text.UTF8Encoding]::new($false)
)
[ordered]@{
  accepted = $true
  artifactPath = $resolvedOutput
  artifactSha256 = $artifactSha256
  controllerVersion = [string]$receipt.controllerVersion
  controllerManifestSha256 = [string]$receipt.controllerManifestSha256
  commitSha = $CommitSha
} | ConvertTo-Json -Compress
