#requires -Version 7.4

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$CommitSha,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$RepositoryRoot = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & git -C $RepositoryRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return @($output)
}

function Add-PayloadFile {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.Dictionary[string,string]]$Files,
    [Parameter(Mandatory = $true)][string]$SourcePath
  )
  $fullSource = [IO.Path]::GetFullPath($SourcePath)
  $relative = [IO.Path]::GetRelativePath($resolvedRepositoryRoot, $fullSource).Replace('\', '/')
  if ($relative.StartsWith('../', [StringComparison]::Ordinal) -or [IO.Path]::IsPathRooted($relative)) {
    throw "Release payload escaped the repository root: $fullSource"
  }
  if ($relative -match '(^|/)(node_modules|\.git|\.local|sources/private|sources/chatgpt)(/|$)' -or $relative -match '(^|/)\.env(?:\.|$)') {
    throw "Forbidden release payload path: $relative"
  }
  if ($Files.ContainsKey($relative)) {
    throw "Duplicate release payload path: $relative"
  }
  $Files.Add($relative, $fullSource)
}

function Add-PayloadTree {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.Dictionary[string,string]]$Files,
    [Parameter(Mandatory = $true)][string]$Root
  )
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Required release payload directory is missing: $Root"
  }
  $items = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force)
  if ($items.Count -eq 0) {
    throw "Required release payload directory is empty: $Root"
  }
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Release payload cannot contain reparse-point files: $($item.FullName)"
    }
    Add-PayloadFile -Files $Files -SourcePath $item.FullName
  }
}

$resolvedRepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path.TrimEnd('\', '/')
$actualSha = ([string](Invoke-Git -Arguments @('rev-parse', 'HEAD') | Select-Object -First 1)).Trim()
if ($actualSha -cne $CommitSha) {
  throw "Repository HEAD $actualSha does not match release SHA $CommitSha."
}
$repositoryChanges = @(Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all'))
if ($repositoryChanges.Count -ne 0) {
  throw "Tracked or untracked repository changes are forbidden while packaging a release."
}

$files = [System.Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
foreach ($rootFile in @('.npmrc', 'package.json', 'package-lock.json')) {
  $path = Join-Path $resolvedRepositoryRoot $rootFile
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required release payload file is missing: $path"
  }
  Add-PayloadFile -Files $files -SourcePath $path
}

$workspaceRoots = @('apps', 'packages', 'services')
foreach ($workspaceRoot in $workspaceRoots) {
  $workspaceParent = Join-Path $resolvedRepositoryRoot $workspaceRoot
  foreach ($workspace in @(Get-ChildItem -LiteralPath $workspaceParent -Directory | Sort-Object Name)) {
    $manifestPath = Join-Path $workspace.FullName 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      continue
    }
    Add-PayloadFile -Files $files -SourcePath $manifestPath
    Add-PayloadTree -Files $files -Root (Join-Path $workspace.FullName 'dist')
  }
}

Add-PayloadTree -Files $files -Root (Join-Path $resolvedRepositoryRoot 'sources\fixtures')

$commitTimestampText = ([string](Invoke-Git -Arguments @('show', '-s', '--format=%cI', $CommitSha) | Select-Object -First 1)).Trim()
$commitTimestamp = [DateTimeOffset]::Parse($commitTimestampText).ToUniversalTime()
$expectedNodeVersion = 'v22.23.2'
$nodeVersion = (& node --version 2>&1).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne $expectedNodeVersion) {
  throw "Release packaging requires Node.js $expectedNodeVersion; observed '$nodeVersion'."
}

$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$stagingRoot = Join-Path $temporaryRoot "unified-ai-orchestrator-release-$([Guid]::NewGuid().ToString('N'))"
$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputParent = Split-Path -Parent $resolvedOutputPath
if ([string]::IsNullOrWhiteSpace($outputParent)) {
  throw 'OutputPath must include a parent directory.'
}
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
if (Test-Path -LiteralPath $resolvedOutputPath) {
  Remove-Item -LiteralPath $resolvedOutputPath -Force
}

try {
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null
  $payloadHashes = [ordered]@{}
  $relativePaths = [System.Collections.Generic.List[string]]::new()
  foreach ($relativePath in $files.Keys) {
    $relativePaths.Add($relativePath)
  }
  $relativePaths.Sort([StringComparer]::Ordinal)

  foreach ($relativePath in $relativePaths) {
    $destination = Join-Path $stagingRoot ($relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $files[$relativePath] -Destination $destination
    [IO.File]::SetLastWriteTimeUtc($destination, $commitTimestamp.UtcDateTime)
    $payloadHashes[$relativePath] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  $packageLockSha256 = $payloadHashes['package-lock.json']
  $manifest = [ordered]@{
    schemaVersion = 1
    commitSha = $CommitSha
    createdAtUtc = $commitTimestamp.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    nodeVersion = $nodeVersion
    packageLockSha256 = $packageLockSha256
    payloadSha256 = $payloadHashes
  }
  $manifestPath = Join-Path $stagingRoot 'release-manifest.json'
  $manifestJson = ($manifest | ConvertTo-Json -Depth 8)
  [IO.File]::WriteAllText($manifestPath, "$manifestJson`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::SetLastWriteTimeUtc($manifestPath, $commitTimestamp.UtcDateTime)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [IO.File]::Open($resolvedOutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      $archivePaths = [System.Collections.Generic.List[string]]::new()
      $archivePaths.Add('release-manifest.json')
      foreach ($relativePath in $relativePaths) {
        $archivePaths.Add($relativePath)
      }
      $archivePaths.Sort([StringComparer]::Ordinal)
      foreach ($relativePath in $archivePaths) {
        $source = Join-Path $stagingRoot ($relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $entry = $archive.CreateEntry($relativePath, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $commitTimestamp
        $input = [IO.File]::OpenRead($source)
        try {
          $output = $entry.Open()
          try {
            $input.CopyTo($output)
          }
          finally {
            $output.Dispose()
          }
        }
        finally {
          $input.Dispose()
        }
      }
    }
    finally {
      $archive.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }

  $archiveSha256 = (Get-FileHash -LiteralPath $resolvedOutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$resolvedOutputPath.sha256", "$archiveSha256  $([IO.Path]::GetFileName($resolvedOutputPath))`n", [Text.UTF8Encoding]::new($false))
  [ordered]@{
    accepted = $true
    artifactPath = $resolvedOutputPath
    artifactSha256 = $archiveSha256
    commitSha = $CommitSha
    payloadFiles = $files.Count
  } | ConvertTo-Json -Compress
}
finally {
  $resolvedStagingRoot = [IO.Path]::GetFullPath($stagingRoot)
  $expectedPrefix = "$temporaryRoot$([IO.Path]::DirectorySeparatorChar)unified-ai-orchestrator-release-"
  if ((Test-Path -LiteralPath $resolvedStagingRoot) -and $resolvedStagingRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force
  }
}
