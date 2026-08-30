# Ollama Orchestration Phase 1 Implementation Plan

Date: 2026-08-28
Design: `docs/superpowers/specs/2026-08-28-ollama-orchestration-phase-1-design.md`
Branch: `feature/ollama-orchestration`
Status: Approved for autonomous execution

## Objective

Deliver and verify the complete Phase 1 vertical slice defined in the approved design:

- pinned local Ollama `qwen3:4b` chat and tool orchestration;
- repository-scoped persistent trust for development branches;
- guarded read and write tools limited to this repository;
- immutable run and tool evidence;
- explicit startup of existing Ollama and WhiteShadow services;
- read-only/model-free WhiteShadow capability access;
- CopilotKit UI over a server-side Copilot Runtime and AG-UI agent;
- clean feature-branch commits and remote backup.

The `writing-plans` skill is unavailable in this session. This repository-grounded plan is the fallback and uses the same design, test, review, and commit gates.

## Global execution rules

- Work only in `D:\Yashu-AI-Workspace\unified-ai-orchestrator`.
- Preserve the WhiteShadow dirty worktree and all other repositories.
- Do not write `main`, `master`, or `release/*`.
- Do not download, update, train, create, or delete an Ollama model.
- Do not expose `.env`, credentials, or local evidence to the browser or model.
- Use tests before or with each behavioral implementation.
- Keep each package independently understandable and typed.
- Run the public-boundary gate before every commit.
- Push only `feature/ollama-orchestration`.

## Work package 1: Workspace and contracts

### Files

- Update `package.json` workspaces and scripts.
- Update `tsconfig.json` project references.
- Update `vitest.config.ts` to include apps.
- Add `.env.example` with public local defaults only.
- Extend `packages/contracts/src/index.ts`.
- Extend `packages/contracts/src/index.test.ts`.
- Add package directories and TypeScript configs for:
  - `packages/policy-engine`
  - `packages/repository-tools`
  - `packages/ollama-client`
  - `packages/agent-runtime`
  - `packages/runtime-manager`
  - `packages/whiteshadow-client`
  - `apps/api`
  - `apps/web`

### Contracts

Add runtime-validated schemas for:

- runtime service state and aggregate status;
- workspace identity and trust grant;
- tool definitions, calls, policy decisions, and results;
- agent run request, status, events, and receipt payload;
- Ollama chat chunks and normalized messages;
- WhiteShadow capability summaries;
- stable error codes.

### Gate

```powershell
npm run typecheck
npm test -- packages/contracts
npm run check:public-boundary
git diff --check
```

## Work package 2: Policy engine and persistent trust

### Files

- `packages/policy-engine/src/workspace-identity.ts`
- `packages/policy-engine/src/trust-store.ts`
- `packages/policy-engine/src/policy-engine.ts`
- `packages/policy-engine/src/index.ts`
- matching focused tests

### Behavior

- Resolve and realpath the configured repository root.
- Normalize and hash the Git origin URL without credentials.
- Persist grants under `.local/trust` with atomic writes.
- Allow documented development branch patterns.
- Always block protected branches.
- Reject path escapes, junction/symlink escapes, protected paths, unknown tools, and untrusted mutations.
- Revalidate repository, remote, branch, and path for every mutation.
- Grant and revoke can be called by the local API but not by model tools.

### Gate

```powershell
npm test -- packages/policy-engine
npm run typecheck
git diff --check
```

## Work package 3: Repository tools

### Files

- `packages/repository-tools/src/path-safety.ts`
- `packages/repository-tools/src/read-tools.ts`
- `packages/repository-tools/src/write-tools.ts`
- `packages/repository-tools/src/npm-tool.ts`
- `packages/repository-tools/src/tool-registry.ts`
- `packages/repository-tools/src/index.ts`
- matching focused tests

### Behavior

- Bounded tracked/public path listing and search.
- Chunked UTF-8 reads with SHA-256.
- Atomic create/replace with expected-hash preconditions.
- Exact text replacement with expected occurrence count.
- Repository-relative directory creation.
- Fixed built-in `check:public-boundary` and `typecheck` execution through direct Node executable vectors, never a shell or mutable package-script body.
- Credential-free child environment and cancellation/timeout propagation.
- Hash/count-only stdout and stderr summaries; raw process output is not returned to the model.
- No Git mutation tool and no arbitrary process tool.

### Gate

```powershell
npm test -- packages/repository-tools
npm run typecheck
npm run verify
```

## Work package 4: Ollama client

### Files

- `packages/ollama-client/src/client.ts`
- `packages/ollama-client/src/ndjson.ts`
- `packages/ollama-client/src/errors.ts`
- `packages/ollama-client/src/index.ts`
- fake-stream fixtures and focused tests

### Behavior

- Health and model-inventory probes.
- Reject configured models other than exact `qwen3:4b`.
- `POST /api/chat` with streaming, tools, `think: false`, 4096 context, and temperature 0.2.
- Two schema-constrained stages when tools are offered: select one offered tool or a final response, then generate arguments under the selected tool's schema.
- Ignore speculative response text attached to a tool decision and reject unoffered names, inconsistent decisions, malformed JSON, and non-object arguments.
- Incremental NDJSON parsing across arbitrary byte boundaries.
- Normalize content, thinking, tool calls, completion metadata, aborts, and API errors.
- Never log prompts or response bodies from the transport layer.

### Gate

```powershell
npm test -- packages/ollama-client
npm run typecheck
```

## Work package 5: Agent runtime and receipts

### Files

- `packages/agent-runtime/src/prompt.ts`
- `packages/agent-runtime/src/agent-loop.ts`
- `packages/agent-runtime/src/event-stream.ts`
- `packages/agent-runtime/src/receipt.ts`
- `packages/agent-runtime/src/index.ts`
- extend `services/evidence-index` only through its public interfaces
- focused unit and integration tests

### Behavior

- Build the fixed system boundary and typed tool catalog.
- Stream validated final-response text and tool lifecycle events.
- Revalidate generated arguments against the fixed repository schema, ask the policy engine, and execute serially.
- Continue with normalized tool results until final text.
- Enforce iteration, tool-count, cancellation, and timeout limits.
- Produce immutable evidence for completed, stopped, failed, and cancelled runs.
- Require successful receipt persistence before reporting a successful run.

### Gate

```powershell
npm test -- packages/agent-runtime services/evidence-index
npm run typecheck
npm run verify
```

## Work package 6: Runtime manager and WhiteShadow client

### Files

- `packages/runtime-manager/src/process-launcher.ts`
- `packages/runtime-manager/src/runtime-manager.ts`
- `packages/runtime-manager/src/index.ts`
- `packages/whiteshadow-client/src/client.ts`
- `packages/whiteshadow-client/src/policy.ts`
- `packages/whiteshadow-client/src/index.ts`
- focused tests with fake probes and process launchers

### Behavior

- Probe first; launch only from explicit API action.
- Start `ollama serve` through `execFile`/`spawn` without a shell and with hidden Windows process settings.
- Verify `qwen3:4b` exists; never pull it.
- Start WhiteShadow from the configured D workspace and its existing `.venv` Python.
- Collapse concurrent starts and use bounded readiness polling.
- Return truthful offline, starting, ready, degraded, and blocked states.
- WhiteShadow adapter exposes exactly four model-free `GET` capabilities: `health`, `runtime-summary`, `skills-catalog`, and `plugins-catalog`.
- `capability-catalog` remains blocked because serving it can conditionally refresh WhiteShadow snapshot files.
- Fail closed when risk or model-use classification is missing.

### Gate

```powershell
npm test -- packages/runtime-manager packages/whiteshadow-client
npm run typecheck
```

## Work package 7: Local API, AG-UI, and Copilot Runtime

### Files

- `apps/api/src/server.ts`
- `apps/api/src/config.ts`
- `apps/api/src/routes/runtime.ts`
- `apps/api/src/routes/trust.ts`
- `apps/api/src/routes/runs.ts`
- `apps/api/src/routes/whiteshadow.ts`
- `apps/api/src/agui/agent-endpoint.ts`
- `apps/api/src/copilot/runtime.ts`
- focused API and event-order tests

### Dependencies

Pin exact verified versions of Express, CORS, Copilot Runtime v2, AG-UI client/core, and test types in the lockfile.

### Behavior

- Bind loopback by default and reject an unsafe bind.
- Expose the design API routes with Zod validation.
- Implement an AG-UI endpoint over the agent runtime.
- Register the AG-UI `HttpAgent` as Copilot Runtime agent `default`.
- Mount supported Copilot Runtime v2 Express routes under `/api/copilotkit`.
- Serve the built web application in non-development mode.
- Return safe error envelopes and never expose stack traces or secrets.

### Gate

```powershell
npm test -- apps/api
npm run typecheck
npm run build
```

## Work package 8: CopilotKit web application

### Files

- Vite/React configuration under `apps/web`.
- `apps/web/src/App.tsx`
- `apps/web/src/components/RuntimeStatus.tsx`
- `apps/web/src/components/TrustPanel.tsx`
- `apps/web/src/components/RepositoryStatus.tsx`
- `apps/web/src/components/RunReceipts.tsx`
- `apps/web/src/components/ToolCard.tsx`
- `apps/web/src/styles.css`
- component tests

### Behavior

- Use CopilotKit v2 with the local `/api/copilotkit` runtime.
- Render chat, streaming assistant text, and tool events.
- Show model, Ollama, WhiteShadow, branch, and trust truth.
- Provide **Start Local AI**, **Grant Permanent Trust**, and **Revoke Trust**.
- Show degraded, blocked, and error states with useful next actions.
- Render recent run receipts without raw prompt/file/secret content.
- Remain usable at desktop and narrow viewport sizes.

### Gate

```powershell
npm test -- apps/web
npm run typecheck
npm run build
```

## Work package 9: Full verification and bounded live acceptance

### Fixture verification

```powershell
npm ci --ignore-scripts
npm run verify
npm run ingest:fixture
npm run verify
git diff --check
git status --short --branch
```

### Browser acceptance

- Start the API and web app with fake external adapters first.
- Verify offline, ready, degraded, trust, chat, tool, receipt, and responsive states.
- Capture screenshots or browser evidence outside tracked runtime data.

### Live acceptance

1. Read current Ollama and WhiteShadow health without mutation.
2. Use **Start Local AI** once if a required service is offline.
3. Prove the exact model inventory or record `model_missing`.
4. If `qwen3:4b` is available, run one streamed chat.
5. Run one read-only repository action.
6. Grant persistent trust and run one reversible repository-local write fixture.
7. Run an allowlisted verification script.
8. Prove protected path and protected branch rejection with non-mutating tests.
9. Restart the app and prove trust persistence, then prove revocation.
10. Probe WhiteShadow capabilities or record degraded state truthfully.
11. Verify every live run receipt.

Do not force a live pass by changing WhiteShadow, downloading a model, weakening policy, or touching a protected branch.

## Work package 10: Documentation and closeout

### Files

- Update `README.md` with installation, startup, security, and use.
- Add an operator runbook under `docs/operations/`.
- Record live acceptance under ignored `.local/evidence` and a public redacted summary if safe.
- Refresh the Codex handoff.

### Final gates

- All fixture and app tests pass.
- Live state is classified with direct evidence.
- Secret and private-identifier scans pass.
- Local evidence remains ignored.
- Worktree is clean.
- Feature branch is pushed.
- Local and remote SHAs match.
- No protected branch or other repository changed.

## Commit checkpoints

1. `docs(plan): add Ollama orchestration phase one plan`
2. `feat(policy): add persistent workspace trust and repository boundary`
3. `feat(agent): add Ollama tool orchestration and evidence receipts`
4. `feat(runtime): add local service manager and WhiteShadow adapter`
5. `feat(api): expose AG-UI and Copilot Runtime`
6. `feat(web): add CopilotKit orchestration console`
7. `docs(operations): document and verify phase one`

Adjacent checkpoints may be combined only when the repository remains buildable and the combined change is easier to review.

## Stop conditions

Stop and record the exact blocker if:

- an operation would modify a protected branch or another repository;
- completing a gate requires a model download/update or WhiteShadow edit;
- the same command fails three consecutive times without new information;
- a required dependency contract cannot be reconciled safely;
- live acceptance requires credentials or authority not already in scope.
