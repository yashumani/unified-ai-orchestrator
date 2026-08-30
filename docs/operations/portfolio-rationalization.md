# Portfolio rationalization live acceptance

This runbook accepts the portfolio rationalization workflow only on
`feature/portfolio-rationalization`. It composes the same services as the local API,
reads the existing GitHub portfolio, uses the already-installed local Ollama model,
and writes local evidence plus a sanitized acceptance report. It does not start the
API server.

## Safety boundary

The live acceptance command is deliberately opt-in and exits nonzero unless every
check passes. Its source boundary is fixed:

- GitHub access is REST-only and restricted by construction to HTTP `GET` and
  `HEAD`. Any other method is rejected before `fetch` is called.
- The collector follows GitHub `Link` pagination, uses ETag conditional reads,
  records rate-limit and `Retry-After` state, and captures before/after default-branch
  fingerprints. It never clones, pushes, edits, deletes, labels, comments, merges,
  closes, releases, or changes repository settings.
- Ollama inventory is read through the loopback `/api/tags` endpoint. The script
  never pulls, creates, copies, or deletes a model.
- The script does not probe, start, or invoke WhiteShadow. Service composition
  constructs the existing adapter, but the acceptance path never calls it.
- Repository mutation tools, recommendation overrides, and ChatGPT import routes
  are not called by the acceptance script.
- The only intended local writes are content-addressed evidence under ignored
  `.local/evidence` and one sanitized JSON report under ignored
  `.local/acceptance`.

This is a feature-branch evidence run. It is not authorization to merge, push,
write to any source repository, modify another checkout, change WhiteShadow, or
touch production/shared infrastructure.

## Credential and branch preflight

From `D:\Yashu-AI-Workspace\unified-ai-orchestrator`:

```powershell
git branch --show-current
git status --short --branch
git check-ignore -v .env .local/acceptance
```

The first command must return exactly `feature/portfolio-rationalization`. Preserve
the status output; the acceptance command must not change tracked source files.

Put one GitHub credential in the existing ignored `.env` file:

```dotenv
GITHUB_TOKEN=<credential with read access to the owned portfolio>
```

`GH_TOKEN` is accepted instead. Configure only one of the two names when practical;
`GITHUB_TOKEN` takes precedence when it is present. The token needs read access to
the owned repositories, including private repositories that belong in the audit.
No GitHub write permission is required. Never paste the token into a command,
terminal transcript, report, issue, or commit.

The script loads the existing `.env` through the API configuration helper. It does
not print the file, credential, authorization header, raw GitHub response, private
repository name, evidence text, citation statement, or recommendation rationale.

## Ollama constraint

Acceptance requires the exact existing model `qwen3:4b` at the pinned loopback
Ollama endpoint. Inspect state without changing it:

```powershell
ollama ps
ollama list
```

If `qwen3:4b` is absent, stop. Do not run `ollama pull`, switch the configured model,
or alter the inventory as part of acceptance. Keep only the intended local workload
active when memory is constrained; the acceptance command itself does not unload or
delete another model. Portfolio classification uses local inference and does not send
repository evidence to WhiteShadow.

## Start exactly one acceptance run

The command below is the authoritative scripted start. Run it once after preflight:

```powershell
npm run portfolio:acceptance -- --live
```

Without the exact `--live` argument, the script exits nonzero before any live request.
On a valid preflight it performs one `PortfolioService.startRun()` call, awaits that
same run with `waitForRun()`, and does not retry the whole run automatically.

Do not also call `POST /api/portfolio/runs` while this command is running. That API
route is an alternative operator surface, not part of this acceptance invocation.

## Read sanitized status

The script prints only pass/fail and the relative sanitized-report path. Read the
latest report without exposing private evidence:

```powershell
$report = Get-ChildItem -LiteralPath .local\acceptance -Filter 'portfolio-live-acceptance-*.json' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

Get-Content -LiteralPath $report.FullName -Raw |
  ConvertFrom-Json |
  Select-Object accepted, observedAt, branch, ollama, run, coverage, failures
```

For a manually started API run outside scripted acceptance, the equivalent local
start/status calls are:

```powershell
$started = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' `
  -Uri 'http://127.0.0.1:8790/api/portfolio/runs'

Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/portfolio/runs/$($started.runId)"
```

Do not use those API commands in the same evidence attempt as the scripted run; doing
so would create a second run and invalidate the “exactly one” operator procedure.

## Required checkpoints

The sanitized report is accepted only when all of these conditions hold:

1. The exact feature branch is active and `qwen3:4b` is already present.
2. The awaited run status is `succeeded`, has a completion timestamp, and reports
   `revisionMismatchCount: 0`.
3. There are exactly 23 source repository projections. The orchestrator repository
   is inventory authority and is excluded from the 23 source projections.
4. There are exactly 23 recommendations, and each source is the primary subject of
   exactly one recommendation.
5. Every source is either in one non-overlapping cluster or is derived as standalone
   by subtracting clustered source IDs from the source inventory.
6. Every source and recommendation has citations; every emitted cluster has
   citations.
7. Every recommendation has a non-empty decision history whose event sequence is
   contiguous from zero and bound to the same run and recommendation.

The report contains only status, timestamps, hashes, counts, Boolean checks, and safe
failure codes/messages. It excludes repository identities, cluster identities,
recommendation identities, file paths, raw evidence, citation content, model output,
warning text, and credentials.

GitHub ingestion records resumable pagination state, rate limits, permission gaps,
renames/deletions, and before/after ref fingerprints. A moving default-branch head is
retried once inside that source capture. A successful portfolio run then persists an
append-only local run checkpoint and decision events in `.local/evidence`; the
sanitized report does not reproduce their private contents.

## ChatGPT evidence path

ChatGPT context is optional, non-authoritative intent evidence. Prefer the official
ChatGPT data export, keep its `conversations.json` only under ignored
`sources/chatgpt/`, and import it through the loopback API before a manually initiated
portfolio run:

```powershell
$conversations = Get-Content -LiteralPath 'sources\chatgpt\conversations.json' -Raw |
  ConvertFrom-Json
$body = @{
  projectId = 'portfolio-rationalization'
  conversations = $conversations
} | ConvertTo-Json -Depth 100

Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body `
  -Uri 'http://127.0.0.1:8790/api/portfolio/chat-imports'
```

When an official export is unavailable, use the existing manual Playwright path. It
opens a headed browser so the operator signs in; the helper never enters credentials:

```powershell
.\scripts\chatgpt-manual-capture.ps1 -Action open -Session portfolio-chatgpt
.\scripts\chatgpt-manual-capture.ps1 -Action snapshot -Session portfolio-chatgpt
.\scripts\chatgpt-manual-capture.ps1 -Action close -Session portfolio-chatgpt
```

Snapshots remain under ignored `.local/imports/chatgpt/playwright`. Review them
locally. They are capture evidence, not an automatic import, and must never be added
to source control. The scripted live acceptance command does not read or print this
raw material.

## Failure states and response

- **Missing `--live`, wrong branch, missing `.env`, or missing credential:** no live
  portfolio run is started. Correct the preflight condition; do not bypass the gate.
- **Ollama unreachable or `qwen3:4b` absent:** no portfolio run is started. Restore
  the existing local runtime separately; do not download or switch models here.
- **GitHub permission gap, incomplete inventory, rate limit, rename/deletion gap, or
  repeated moving HEAD:** the run fails closed. Respect `Retry-After`, repair read
  access, or review the local checkpoint before one deliberate retry.
- **Run status failed:** the script never substitutes projections from an older
  successful run. It writes zero current projections into the failure report.
- **Count, citation, cluster, decision-history, or revision check fails:** the report
  is written with `accepted: false` and the process exits nonzero. Do not merge.
- **Sanitization or report-path check fails:** serialization/write is refused and the
  process exits nonzero without printing the unsafe value.
- **WhiteShadow unavailable:** it is outside this acceptance path. Do not start or
  change WhiteShadow to make the portfolio check pass.

After the command, compare tracked state with the preflight snapshot:

```powershell
git status --short --branch
git diff --check
```

Any unexpected tracked change is a failed operator boundary, even if the JSON report
says `accepted: true`. A passing report is local feature-branch evidence only; it is
not a merge, deployment, publication, or source-write authorization.
