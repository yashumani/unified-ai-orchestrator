# Ollama Orchestration Phase 1 Design

Date: 2026-08-28
Status: Approved for implementation
Branch: `feature/ollama-orchestration`

## 1. Purpose

Phase 1 turns Unified AI Orchestrator into a usable local application that can:

1. start and inspect the existing local AI services without downloading or updating models;
2. stream chat and tool calls from the pinned Ollama model `qwen3:4b`;
3. inspect and modify only this repository through typed, policy-controlled tools;
4. retain a permanent local trust grant for development branches until the user revokes it;
5. expose model-free, allowlisted WhiteShadow capabilities without changing the WhiteShadow repository;
6. show the interaction through CopilotKit and AG-UI;
7. write immutable evidence and receipts for every run and tool decision.

This phase is the first complete orchestration slice. It is not the full multi-repository consolidation product.

## 2. Approved user decisions

- Provide both conversational LLM behavior and agent capabilities.
- Permit file and code changes after trust is granted.
- Limit all writes to `D:\Yashu-AI-Workspace\unified-ai-orchestrator`.
- Keep every other repository read-only.
- Pin app reasoning to Ollama model `qwen3:4b`.
- Use a dual-adapter architecture:
  - direct Ollama inference for reasoning and tool selection;
  - a separate WhiteShadow client for existing allowlisted capabilities.
- Start local services only through an explicit **Start Local AI** action.
- Never download, update, create, train, or replace a model automatically.
- Persist workspace trust across restarts until explicitly revoked.
- Apply persistent trust to development and feature branches in this repository.
- Always exclude `main`, `master`, and `release/*` from persistent trust.
- Preserve the WhiteShadow worktree and do not modify it.
- Continue implementation autonomously through verified Phase 1 completion.

## 3. Non-goals

Phase 1 does not:

- modify, merge, commit, push, or deploy another repository;
- write to `main`, `master`, or `release/*`;
- provide arbitrary shell access;
- expose secrets to the model, browser, receipts, or logs;
- call WhiteShadow chat or any WhiteShadow path that loads a second LLM;
- perform model downloads, updates, training, promotion, or deletion;
- deploy to a shared or production environment;
- ingest live ChatGPT sessions;
- claim multi-repository consolidation is complete.

## 4. Architecture

```text
CopilotKit web application
        |
        | Copilot Runtime and AG-UI events
        v
Unified Orchestrator API
        |
        +--> Ollama adapter --> http://127.0.0.1:11434/api/chat
        |                       pinned qwen3:4b
        |
        +--> Agent loop --> policy engine --> repository tools
        |                                  --> npm verification tools
        |
        +--> WhiteShadow client --> http://127.0.0.1:8787
        |                           model-free allowlisted capabilities only
        |
        +--> immutable evidence store under .local/evidence
        |
        +--> local trust store under .local/trust
```

The model proposes text or typed tool calls. The orchestrator alone decides whether a tool exists, whether its arguments are valid, whether the current workspace is trusted, whether the branch is permitted, and whether the operation stays inside the repository.

CopilotKit owns the user interaction. AG-UI carries lifecycle, message, tool, state, and error events. Neither layer gains execution authority.

## 5. Repository layout

```text
apps/
  api/
    src/
      server.ts
      routes/
      runtime/
  web/
    src/
      App.tsx
      components/
      api/
packages/
  contracts/
  agent-runtime/
  ollama-client/
  policy-engine/
  repository-tools/
  runtime-manager/
  whiteshadow-client/
services/
  evidence-index/
  session-ingestion/
sources/
  fixtures/
```

Each package has one responsibility and exports a narrow typed interface. Apps compose packages; packages do not import app code.

## 6. Ollama adapter

### 6.1 Endpoint and model

- Base URL: `http://127.0.0.1:11434` by default.
- Chat endpoint: `POST /api/chat`.
- Exact model: `qwen3:4b`.
- Streaming: enabled.
- Thinking mode: disabled with `think: false`.
- Context: `num_ctx: 4096`.
- Temperature: `0.2`.
- Keep-alive: bounded and configurable; only one reasoning model may be active.

The adapter validates every newline-delimited JSON chunk and normalizes text, thinking, tool calls, completion metadata, and errors into repository contracts.

### 6.2 Tool loop

For each user turn:

1. Build a system prompt containing the repository boundary and available tool schemas.
2. Send conversation messages and tool schemas to Ollama.
3. Stream assistant text and tool-call events.
4. Validate every requested tool name and argument object.
5. Ask the policy engine for an execution decision.
6. Execute permitted tools one at a time.
7. Append tool results to the conversation.
8. Continue until the model returns final text or the run reaches its limit.

Limits:

- maximum 8 model iterations per run;
- maximum 12 tool calls per run;
- one tool executes at a time;
- bounded request and tool timeouts;
- cancellation propagates from UI to model and tools;
- exceeding a limit produces a stopped receipt, not an implicit retry loop.

The model never receives raw `.env`, Git credentials, browser authentication state, or local evidence-store contents.

## 7. Runtime manager

The **Start Local AI** action performs bounded local startup.

### 7.1 Ollama startup

1. Probe `GET /api/version`.
2. If reachable, probe `GET /api/tags` and confirm `qwen3:4b` exists.
3. If unreachable, locate the already installed `ollama` executable.
4. Launch `ollama serve` without a shell and without a visible window.
5. Poll readiness for a bounded period.
6. Recheck the model inventory.

If the executable or model is absent, startup fails with a precise operator message. The app never runs `ollama pull`, `ollama create`, an updater, or a model deletion command.

### 7.2 WhiteShadow startup

1. Probe `GET http://127.0.0.1:8787/api/health`.
2. If unreachable, verify the configured WhiteShadow workspace resolves to `D:\whiteshadow-workspace\local-llm-ws`.
3. Verify the configured Python executable belongs to that workspace, preferring `.venv\Scripts\python.exe`.
4. Launch `python -m training.webapp.server --host 127.0.0.1 --port 8787` without a shell and without a visible window.
5. Poll readiness for a bounded period.

The manager does not edit WhiteShadow, install dependencies, run training, or stop unrelated processes.

### 7.3 Runtime states

- `offline`: service cannot be reached.
- `starting`: one bounded launch is active.
- `ready`: health and required inventory checks pass.
- `degraded`: Ollama chat is usable but WhiteShadow capabilities are unavailable, or vice versa.
- `blocked`: required executable, workspace, or model is missing.

Concurrent start requests collapse into the same in-flight operation.

## 8. Persistent workspace trust

### 8.1 Storage

The grant is stored at `.local/trust/workspace-grant.json`, which is ignored by Git.

The grant contains:

- schema version;
- resolved repository root;
- normalized origin URL fingerprint;
- allowed branch patterns;
- grant timestamp;
- active/revoked status;
- revocation timestamp when applicable.

No credential is stored in the trust document.

### 8.2 Validation on every mutation

Persistent trust is necessary but not sufficient. Before every write or command, the policy engine rechecks:

1. the repository root is the configured canonical root;
2. the current path resolves inside that root;
3. the origin fingerprint matches the grant;
4. the active branch is allowed;
5. the branch is not `main`, `master`, or `release/*`;
6. no path component escapes through a symlink or junction;
7. the target is not protected;
8. the tool and arguments match the allowlist.

Allowed branch classes:

- `dev`
- `dev-*`
- `feature/*`
- `codex/*`
- `codex_ys/*`
- `backup/*`

### 8.3 Protected paths

The model and tool runner cannot read or modify:

- `.env` or `.env.*` other than the public `.env.example`;
- `.git/` internals;
- `.local/` trust, evidence, logs, and caches;
- `node_modules/`;
- build output and model caches;
- browser profiles or raw/private source folders blocked by the public boundary.

### 8.4 Revocation

The UI always exposes **Revoke Trust**. Revocation is immediate and prevents the next mutation. Trust cannot be granted or restored by an LLM tool call.

## 9. Repository tools

Phase 1 exposes these typed tools:

### Read-only

- `repo_list_paths`: list bounded repository-relative paths.
- `repo_read_text`: read a UTF-8 text chunk with hash and line metadata.
- `repo_search_text`: search tracked/public text using bounded patterns.
- `repo_git_status`: return branch and porcelain status.
- `repo_git_diff`: return a bounded unstaged/staged diff.

### Mutating

- `repo_write_text`: create or replace a UTF-8 text file with an expected-hash precondition.
- `repo_replace_text`: replace an exact text occurrence with expected-hash and occurrence-count preconditions.
- `repo_create_directory`: create a bounded repository directory.
- `repo_run_npm_script`: run an allowlisted script already declared in the root `package.json`.

Initial npm script allowlist:

- `typecheck`
- `test`
- `build`
- `verify`
- `ingest:fixture`

The phase does not expose arbitrary shell, arbitrary process execution, package installation, Git commit, Git push, branch deletion, reset, clean, stash, or checkout tools to the model.

Writes use atomic temporary-file replacement where possible. Existing-file mutations require the SHA-256 observed by the model so concurrent user edits fail as conflicts instead of being overwritten.

## 10. WhiteShadow adapter

WhiteShadow remains a separate, read-only dependency in Phase 1.

The adapter may call:

- health and runtime status;
- capability catalog endpoints;
- harness capability inventory;
- explicitly approved model-free, safe/read-only harness actions.

The adapter must reject:

- WhiteShadow chat endpoints;
- model-upgrade, training, deploy, and promotion actions;
- JobBus actions classified as risky or blocked;
- file mutation, shell, credential, live-trading, publishing, or browser-side-effect actions;
- any capability whose risk or model-use classification is missing.

If WhiteShadow is unavailable, Ollama chat and repository tools continue in `degraded` mode. The UI reports that capability enrichment is unavailable.

## 11. Evidence and receipts

Every agent run produces an immutable receipt linked to content-addressed evidence.

The receipt records:

- run, thread, and message identifiers;
- start and completion timestamps;
- exact model name;
- runtime configuration excluding secrets;
- prompt and response hashes;
- tool schemas offered;
- each tool request and normalized arguments;
- policy decision and reason;
- tool result hash and bounded summary;
- branch and repository fingerprints;
- trust-grant fingerprint;
- final status: `completed`, `stopped`, `failed`, or `cancelled`;
- token and duration metadata when supplied by Ollama.

Raw secret values are never evidence. File contents are stored only when required for an explicit evidence object; receipts prefer hashes and bounded summaries.

## 12. API surface

Local API binds to `127.0.0.1` by default.

Initial routes:

- `GET /api/health`
- `GET /api/runtime/status`
- `POST /api/runtime/start`
- `GET /api/trust`
- `POST /api/trust/grant`
- `POST /api/trust/revoke`
- `GET /api/whiteshadow/capabilities`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `POST /api/agent` for AG-UI execution
- Copilot Runtime routes under `/api/copilotkit`

The server rejects non-loopback binding unless a future separately approved design adds authentication and network exposure.

## 13. CopilotKit application

The local web app contains:

- service status for Ollama and WhiteShadow;
- **Start Local AI**;
- model label fixed to `qwen3:4b`;
- workspace trust state and **Revoke Trust**;
- CopilotKit chat;
- inline tool-call cards showing tool, arguments, policy outcome, and result;
- current Git branch and clean/dirty state;
- recent immutable run receipts;
- explicit degraded and blocked states.

The frontend does not receive `.env` values or filesystem authority. All execution remains server-side.

Copilot Runtime proxies the local AG-UI agent so routing and middleware stay server-side. The app uses the supported runtime-backed integration rather than the development-only direct-agent shortcut.

## 14. Configuration

Public defaults belong in `.env.example`:

```dotenv
ORCHESTRATOR_HOST=127.0.0.1
ORCHESTRATOR_PORT=4310
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
WHITESHADOW_BASE_URL=http://127.0.0.1:8787
WHITESHADOW_WORKSPACE=D:\whiteshadow-workspace\local-llm-ws
```

The runtime rejects an `OLLAMA_MODEL` value other than `qwen3:4b` in Phase 1. Local `.env` may contain credentials for future adapters, but Phase 1 does not require a cloud model credential.

## 15. Error handling

- Invalid input returns a typed validation error.
- Ollama unavailable returns `runtime_offline` with the bounded start action.
- Missing `qwen3:4b` returns `model_missing`; no download begins.
- Malformed stream chunks end the run as `failed` and preserve a receipt.
- Unknown or malformed tool calls are returned to the model as rejected tool results.
- Protected branch, path, or tool requests fail closed before execution.
- Stale file hashes return `write_conflict` without modifying the file.
- Tool timeout stops the tool and records `tool_timeout`.
- Loop limits return `run_limit_reached` with partial evidence.
- WhiteShadow failure changes status to `degraded` without breaking Ollama chat.
- Receipt write failure prevents a successful completion claim.

Errors shown in the UI contain stable codes and safe summaries, not stack traces or secrets.

## 16. Testing strategy

### Unit tests

- runtime and API contracts;
- Ollama NDJSON parsing;
- tool-call normalization;
- branch policy and persistent trust validation;
- path traversal and symlink/junction escapes;
- protected path rejection;
- expected-hash write conflicts;
- command allowlist;
- WhiteShadow capability classification;
- secret redaction;
- evidence receipt integrity.

### Integration tests

- fake Ollama streaming text;
- fake Ollama streaming one and multiple tool calls;
- tool result continuation to a final answer;
- cancellation and iteration limits;
- fake WhiteShadow ready, degraded, risky, and malformed responses;
- explicit runtime start with fake process and health dependencies;
- API trust grant and revocation;
- AG-UI event order;
- Copilot Runtime discovery and agent run.

### App tests

- offline, starting, ready, degraded, and blocked runtime states;
- trust grant and revoke display;
- chat response streaming;
- tool cards and repository status;
- error and empty states;
- browser smoke at desktop and narrow viewport.

Live tests are separate from fixture tests. A fake passing test is not proof that the local Ollama or WhiteShadow process is running.

## 17. Phase 1 acceptance criteria

Phase 1 is complete only when all of the following are true:

1. A clean install and build succeed from the canonical repository.
2. Public-boundary, type, unit, integration, and app tests pass.
3. The browser app loads locally and reports runtime status truthfully.
4. **Start Local AI** performs bounded startup without downloads or updates.
5. A live or explicitly classified blocked Ollama probe is recorded.
6. When Ollama is available, `qwen3:4b` streams a chat response through the app.
7. The agent performs at least one read-only repository tool call.
8. The agent performs one reversible, repository-scoped file edit on a development branch, validates it, and restores or commits the intended fixture change according to the test plan.
9. Protected paths and protected branches are proven blocked.
10. Permanent trust survives an app restart and revocation takes effect immediately.
11. WhiteShadow capabilities are either proven live through allowlisted model-free calls or reported as degraded without false readiness.
12. Every live run has a verified immutable receipt.
13. No secret, raw private session data, model blob, or local evidence file is tracked.
14. The feature branch is clean, committed, pushed, and matches its remote SHA.
15. `main`, other repositories, and production resources remain unchanged.

## 18. Delivery order

1. Expand contracts and package structure.
2. Implement policy and persistent trust.
3. Implement repository tools.
4. Implement Ollama streaming client.
5. Implement the agent loop and receipts.
6. Implement runtime manager.
7. Implement WhiteShadow capability client.
8. Implement API and AG-UI surface.
9. Implement CopilotKit application.
10. Run fixture, browser, and bounded live acceptance.
11. Commit, push, and record exact evidence.

## 19. Source references

- Ollama chat API: https://docs.ollama.com/api/chat
- Ollama streaming: https://docs.ollama.com/capabilities/streaming
- CopilotKit runtime: https://docs.copilotkit.ai/backend/copilot-runtime
- CopilotKit runtime adapters: https://docs.copilotkit.ai/a2a/runtime-server-adapter
- CopilotKit runtime endpoints: https://docs.copilotkit.ai/a2a/backend/runtime-endpoints
