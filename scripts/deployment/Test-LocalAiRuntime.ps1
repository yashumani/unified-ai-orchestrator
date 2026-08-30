#requires -Version 7.4

[CmdletBinding()]
param(
  [string]$RepositoryRoot = "D:\Yashu-AI-Workspace\unified-ai-orchestrator",
  [ValidateRange(15, 300)][int]$TimeoutSeconds = 180
)

. (Join-Path $PSScriptRoot "Deployment.Common.ps1")

$RepositoryRoot = Assert-CanonicalRepositoryRoot -RepositoryRoot $RepositoryRoot
$handler = [System.Net.Http.SocketsHttpHandler]::new()
$handler.UseProxy = $false
$client = [System.Net.Http.HttpClient]::new($handler, $true)
$client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory)][ValidateSet("GET", "POST")][string]$Method,
    [Parameter(Mandatory)][string]$Uri,
    [System.Collections.IDictionary]$Body
  )

  $request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::new($Method),
    $Uri
  )
  $request.Headers.Accept.ParseAdd("application/json")
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 10 -Compress
    $request.Content = [System.Net.Http.StringContent]::new(
      $json,
      [System.Text.Encoding]::UTF8,
      "application/json"
    )
  }
  $response = $null
  try {
    $response = $client.Send($request)
    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      throw "Loopback runtime request returned HTTP $([int]$response.StatusCode)."
    }
    return ($content | ConvertFrom-Json -AsHashtable)
  } finally {
    $request.Dispose()
    if ($null -ne $response) {
      $response.Dispose()
    }
  }
}

try {
  [void](Invoke-JsonRequest `
      -Method POST `
      -Uri "http://127.0.0.1:8790/api/runtime/start" `
      -Body ([ordered]@{}))
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $runtime = Invoke-JsonRequest -Method GET -Uri "http://127.0.0.1:8790/api/runtime/status"
    if ([string]$runtime.model -ceq "qwen3:4b" -and
        [string]$runtime.ollama.phase -ceq "ready" -and
        [string]$runtime.ollama.model -ceq "qwen3:4b" -and
        [string]$runtime.whiteshadow.phase -ceq "ready") {
      break
    }
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      throw "Local AI services did not become ready: Ollama=$([string]$runtime.ollama.phase), WhiteShadow=$([string]$runtime.whiteshadow.phase)."
    }
    Start-Sleep -Milliseconds 500
  } while ($true)

  $capabilities = Invoke-JsonRequest `
    -Method GET `
    -Uri "http://127.0.0.1:8790/api/whiteshadow/capabilities"
  if (-not [bool]$capabilities.available -or
      @($capabilities.capabilities | Where-Object { [string]$_.capabilityId -ceq "health" }).Count -ne 1) {
    throw "WhiteShadow did not expose its exact allowlisted health capability."
  }
  $whiteShadowHealth = Invoke-JsonRequest `
    -Method GET `
    -Uri "http://127.0.0.1:8790/api/whiteshadow/capabilities/health"
  if ([string]$whiteShadowHealth.capabilityId -cne "health" -or
      [string]::IsNullOrWhiteSpace([string]$whiteShadowHealth.summary)) {
    throw "WhiteShadow health capability did not return a governed summary."
  }

  $ollama = Invoke-JsonRequest `
    -Method POST `
    -Uri "http://127.0.0.1:11434/api/chat" `
    -Body ([ordered]@{
        model = "qwen3:4b"
        stream = $false
        keep_alive = "5m"
        messages = @([ordered]@{
            role = "user"
            content = "Reply with one short word confirming readiness."
          })
        options = [ordered]@{
          num_ctx = 4096
          temperature = 0
        }
      })
  $responseText = [string]$ollama.message.content
  if ([string]$ollama.model -cne "qwen3:4b" -or
      -not [bool]$ollama.done -or
      [string]::IsNullOrWhiteSpace($responseText)) {
    throw "Pinned Ollama model did not complete the bounded live inference."
  }
  $responseHash = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($responseText))
  ).ToLowerInvariant()
  [ordered]@{
    accepted = $true
    model = "qwen3:4b"
    ollamaPhase = [string]$runtime.ollama.phase
    whiteShadowPhase = [string]$runtime.whiteshadow.phase
    whiteShadowCapability = [string]$whiteShadowHealth.capabilityId
    ollamaResponseSha256 = $responseHash
  } | ConvertTo-Json -Depth 10
} finally {
  $client.Dispose()
}
