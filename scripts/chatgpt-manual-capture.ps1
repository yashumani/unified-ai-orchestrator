[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("open", "snapshot", "close")]
  [string]$Action,

  [ValidatePattern("^[a-z0-9][a-z0-9-]{0,62}$")]
  [string]$Session = "uao-chatgpt-manual"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$captureRoot = Join-Path $repositoryRoot ".local\imports\chatgpt\playwright"
$chatGptUrl = "https://chatgpt.com/"

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  throw "npx is required. Install Node.js/npm before using manual ChatGPT capture."
}

New-Item -ItemType Directory -Path $captureRoot -Force | Out-Null
Push-Location $captureRoot
try {
  $baseArguments = @(
    "--yes",
    "--package",
    "@playwright/cli",
    "playwright-cli",
    "--session",
    $Session
  )

  switch ($Action) {
    "open" {
      Write-Host "A headed browser will open. Sign in manually; this script never enters credentials."
      & npx @baseArguments open $chatGptUrl --headed
    }
    "snapshot" {
      $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $snapshotPath = Join-Path $captureRoot "snapshot-$timestamp.txt"
      & npx @baseArguments snapshot 2>&1 | Out-File -LiteralPath $snapshotPath -Encoding utf8
      if ($LASTEXITCODE -ne 0) {
        throw "Playwright snapshot failed. Re-open the named session and try again."
      }
      Write-Host "Sensitive snapshot saved under ignored local evidence: $snapshotPath"
    }
    "close" {
      & npx @baseArguments close
    }
  }

  if ($LASTEXITCODE -ne 0) {
    throw "Playwright CLI action failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
