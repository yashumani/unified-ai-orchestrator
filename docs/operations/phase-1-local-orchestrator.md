# Phase 1 Local Orchestrator Runbook

This runbook operates the Phase 1 application only in `D:\Yashu-AI-Workspace\unified-ai-orchestrator`. It does not authorize changes to another repository, WhiteShadow source, a protected branch, production infrastructure, or the local model inventory.

## 1. Preflight

From the repository root:

```powershell
git status --short --branch
node --version
npm run verify
npm run build
```

The branch must be an allowed development branch. Do not grant trust on `main`, `master`, or `release/*`.

Confirm `.env` is ignored without printing its contents:

```powershell
git check-ignore -v .env
```

Phase 1 requires `OLLAMA_MODEL=qwen3:4b`. Configuration rejects any other model value.

## 2. Start the application

```powershell
npm start
```

The application serves the console and API at `http://127.0.0.1:8790` by default. It does not start Ollama or WhiteShadow merely because the web server starts.

Probe application and runtime state:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8790/api/health
Invoke-RestMethod -Uri http://127.0.0.1:8790/api/runtime/status
```

## 3. Explicitly start local AI services

Use the **Start Local AI** button, or make the equivalent bounded local request:

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' -Uri http://127.0.0.1:8790/api/runtime/start
```

The runtime manager probes first. When a service is offline, it can start only the configured existing Ollama executable and the configured existing WhiteShadow Python entrypoint. It never installs software or pulls a model.

An Ollama inference request is bounded to 120 seconds and a complete agent run to 300 seconds. Cold model load is allowed inside those limits; a timeout never triggers a model download or automatic retry.

Interpret the aggregate state as follows:

- `ready`: Ollama is usable with the exact pinned model and WhiteShadow is reachable.
- `degraded`: the primary local chat path is usable but an optional dependency such as WhiteShadow is unavailable.
- `blocked`: a required condition such as the pinned model inventory is not satisfied.
- `offline` or `starting`: the service is not ready yet; inspect the bounded status message before retrying.

## 4. Repository trust

Read current trust:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8790/api/trust
```

Grant trust only after checking the repository identity returned by the local trust endpoint and the branch displayed in the console:

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' -Uri http://127.0.0.1:8790/api/trust/grant
```

The ignored trust document is bound to the current repository identity. Every mutation rechecks the repository, remote, branch, target path, expected content hash, and tool policy.

Revoke trust:

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' -Uri http://127.0.0.1:8790/api/trust/revoke
```

Revocation does not remove run receipts.

## 5. Evidence and WhiteShadow

List recent redacted receipt summaries:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/runs?limit=20'
```

Receipts are stored under ignored `.local/evidence` with SHA-256 integrity sidecars. A successful agent run is not reported complete until its receipt is persisted.

Read the live WhiteShadow capability feed:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8790/api/whiteshadow/capabilities
```

The feed returns capabilities only while the adapter's live health probe is ready; offline or degraded states return an empty list plus the current status. The browser offers catalog visibility only. The adapter rejects unlisted, state-changing, training, inference, or ambiguously classified WhiteShadow operations.

The complete Phase 1 allowlist contains exactly four model-free HTTP `GET` capabilities:

- `health`
- `runtime-summary`
- `skills-catalog`
- `plugins-catalog`

`capability-catalog` is intentionally excluded. WhiteShadow may refresh local snapshot files while serving it when its cache is absent or invalid, which does not satisfy this phase's strict read-only boundary.

## 6. Recovery

- If the console cannot connect, confirm `npm start` is running and probe `/api/health`.
- If Ollama is offline, use the explicit start action once and reread `/api/runtime/status`.
- If the status reports the pinned model missing, stop. Do not pull or change models as part of Phase 1.
- If WhiteShadow is unavailable but Ollama is ready, continue in the reported degraded mode; do not modify the WhiteShadow repository.
- If a write is denied, read the policy code in the tool result. Do not weaken path, branch, trust, or hash checks.
- If a receipt fails integrity validation, treat it as invalid evidence and preserve the files for diagnosis.

## 7. Closeout checks

```powershell
npm run verify
npm run ingest:fixture
npm run verify
git diff --check
git status --short --branch
```

Before calling Phase 1 complete, separately record fixture-test results, live Ollama state, live WhiteShadow state, streamed chat evidence, repository-tool evidence, trust persistence and revocation, receipt integrity, feature-branch commit SHA, and remote feature-branch SHA.
