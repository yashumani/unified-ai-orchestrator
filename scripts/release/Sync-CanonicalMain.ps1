#requires -Version 7.4

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedSha,

  [string]$RepositoryRoot = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$canonicalRepositoryRoot = 'D:\Yashu-AI-Workspace\unified-ai-orchestrator'

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure
  )
  $output = & git -C $resolvedRepositoryRoot @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = [object[]]@($output) }
}

$resolvedRepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path.TrimEnd('\', '/')
$resolvedCanonicalRoot = (Resolve-Path -LiteralPath $canonicalRepositoryRoot).Path.TrimEnd('\', '/')
if (-not $resolvedRepositoryRoot.Equals($resolvedCanonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Deployment source must be the canonical repository $resolvedCanonicalRoot."
}

$status = Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all')
if ($status.Output.Count -ne 0) {
  throw "Canonical repository is not clean; refusing to synchronize main: $($status.Output -join ', ')"
}
$origin = ([string](Invoke-Git -Arguments @('remote', 'get-url', 'origin')).Output[0]).Trim()
if ($origin -cne 'https://github.com/yashumani/unified-ai-orchestrator.git') {
  throw "Unexpected origin URL: $origin"
}

$previousPrompt = $env:GIT_TERMINAL_PROMPT
try {
  $env:GIT_TERMINAL_PROMPT = '0'
  $fetch = & git -c credential.helper= -C $resolvedRepositoryRoot fetch --no-tags origin main 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Unauthenticated origin/main fetch failed: $($fetch -join [Environment]::NewLine)"
  }
}
finally {
  if ($null -eq $previousPrompt) {
    Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
  }
  else {
    $env:GIT_TERMINAL_PROMPT = $previousPrompt
  }
}

$remoteSha = ([string](Invoke-Git -Arguments @('rev-parse', 'refs/remotes/origin/main')).Output[0]).Trim()
if ($remoteSha -cne $ExpectedSha) {
  throw "origin/main $remoteSha does not match workflow SHA $ExpectedSha."
}

$localMain = Invoke-Git -Arguments @('show-ref', '--verify', '--quiet', 'refs/heads/main') -AllowFailure
if ($localMain.ExitCode -eq 0) {
  $ancestor = Invoke-Git -Arguments @('merge-base', '--is-ancestor', 'refs/heads/main', $ExpectedSha) -AllowFailure
  if ($ancestor.ExitCode -ne 0) {
    throw 'Local main cannot be fast-forwarded to the expected SHA.'
  }
  Invoke-Git -Arguments @('switch', 'main') | Out-Null
  Invoke-Git -Arguments @('merge', '--ff-only', $ExpectedSha) | Out-Null
}
elseif ($localMain.ExitCode -eq 1) {
  Invoke-Git -Arguments @('switch', '--create', 'main', '--track', 'origin/main') | Out-Null
}
else {
  throw "Unable to inspect the local main branch (git exit $($localMain.ExitCode))."
}

$headSha = ([string](Invoke-Git -Arguments @('rev-parse', 'HEAD')).Output[0]).Trim()
$branch = ([string](Invoke-Git -Arguments @('branch', '--show-current')).Output[0]).Trim()
$finalStatus = (Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all')).Output
if ($headSha -cne $ExpectedSha -or $branch -cne 'main' -or $finalStatus.Count -ne 0) {
  throw "Canonical main verification failed after synchronization."
}

[ordered]@{
  accepted = $true
  branch = $branch
  commitSha = $headSha
  originMainSha = $remoteSha
  clean = $true
} | ConvertTo-Json -Compress
