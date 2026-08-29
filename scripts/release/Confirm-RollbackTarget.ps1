#requires -Version 7.4

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedPreviousSha,

  [string]$RepositoryRoot = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$canonicalRepositoryRoot = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator'
$resolvedRepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path.TrimEnd('\', '/')
$resolvedCanonicalRoot = (Resolve-Path -LiteralPath $canonicalRepositoryRoot).Path.TrimEnd('\', '/')
if (-not $resolvedRepositoryRoot.Equals($resolvedCanonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Rollback target must be checked in the canonical repository $resolvedCanonicalRoot."
}

$previousPointerPath = Join-Path $resolvedRepositoryRoot '.local\deployment\previous.json'
if (-not (Test-Path -LiteralPath $previousPointerPath -PathType Leaf)) {
  throw 'No previous local release is available for rollback.'
}
$previous = Get-Content -LiteralPath $previousPointerPath -Raw | ConvertFrom-Json
$previousSha = [string]$previous.commitSha
if ($previousSha -notmatch '^[0-9a-f]{40}$') {
  throw 'The previous-release pointer does not contain a valid commitSha.'
}
if ($previousSha -cne $ExpectedPreviousSha) {
  throw "Requested rollback SHA $ExpectedPreviousSha does not match the available previous release $previousSha."
}

[ordered]@{
  accepted = $true
  previousCommitSha = $previousSha
  pointerPath = $previousPointerPath
} | ConvertTo-Json -Compress
