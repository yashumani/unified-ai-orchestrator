# Unified AI Orchestrator

Unified AI Orchestrator is a loopback-only local application for governed AI work inside this repository. Phase 1 combines a pinned Ollama model (`qwen3:4b`), a CopilotKit chat console, guarded repository tools, persistent repository-scoped trust, read-only WhiteShadow capability discovery, and immutable run receipts. Phase 2 adds a GET/HEAD-only GitHub portfolio audit, deterministic overlap analysis, cited local-model recommendations, ChatGPT intent-evidence import, and a rationalization dashboard.

The approved architectures and delivery gates are in the [Phase 1 design](docs/superpowers/specs/2026-08-28-ollama-orchestration-phase-1-design.md), [Phase 1 implementation plan](docs/plans/2026-08-28-ollama-orchestration-phase-1-implementation-plan.md), [Phase 2 design](docs/superpowers/specs/2026-08-28-portfolio-rationalization-phase-2-design.md), and [Phase 2 implementation plan](docs/plans/2026-08-28-portfolio-rationalization-phase-2-implementation-plan.md). The complete system and dashboard lifecycle are illustrated in the [interactive architecture diagram](docs/architecture/unified-ai-orchestrator-framework.html).

## Safety boundary

- The API and web application bind to loopback only.
- Phase 1 accepts only the exact local model `qwen3:4b`; it never pulls, updates, trains, creates, or deletes models.
- Model tools are limited to this Git repository. There is no arbitrary shell or Git mutation tool.
- Writes require a matching persistent trust grant and an allowed development branch: `dev`, `dev-*`, `feature/*`, `codex/*`, `codex_ys/*`, or `backup/*`.
- `main`, `master`, and `release/*` are always protected. Environment files, local evidence, trust records, Git metadata, model caches, and private source directories are protected paths.
- WhiteShadow remains a separate dependency. Phase 1 permits only four model-free `GET` capabilities: `health`, `runtime-summary`, `skills-catalog`, and `plugins-catalog`.
- The browser receives bounded status, tool summaries, and receipt metadata—not prompts, file bodies, credentials, or raw local evidence.

This repository is public. Never commit raw ChatGPT transcripts, credentials, browser profiles, private repository content or identifiers, attachments, model caches, or local evidence. `.env` and `.local/` are ignored by Git.

## Prerequisites

- Windows with PowerShell
- Node.js 22 or newer
- Existing Ollama installation at the configured path
- Existing local `qwen3:4b` model
- Optional existing WhiteShadow workspace at `D:\whiteshadow-workspace\local-llm-ws`

No cloud model credential is needed for Phase 1.

## Install and configure

```powershell
npm install
```

If `.env` does not already exist, create it from the public template:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

Keep credentials only in `.env`. Do not place a GitHub personal access token in source, documentation, command history, or browser-visible configuration. Phase 1 does not require one; Phase 2 live portfolio inventory uses `GITHUB_TOKEN` or `GH_TOKEN` through an injected credential provider and rejects every GitHub method except `GET` and `HEAD`.

The defaults are:

- application: `http://127.0.0.1:8790`
- Ollama: `http://127.0.0.1:11434`
- WhiteShadow: `http://127.0.0.1:8787`

## Build, verify, and run

```powershell
npm run verify
npm run ingest:fixture
npm run build
npm start
```

Open `http://127.0.0.1:8790`. The built API serves the web console from the same loopback origin.

For UI development, run the API and Vite server in separate terminals:

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

Then open `http://127.0.0.1:4311`. Vite proxies `/api` to the API on port `8790`.

## Operator flow

1. Open the console and inspect current Ollama, WhiteShadow, branch, and trust state.
2. Select **Start Local AI** only when you want the app to start the already-installed services. Startup probes first and never downloads a model.
3. Use chat for read-only inspection immediately.
4. Select **Grant permanent trust** only on the intended development branch before asking for a repository write.
5. Inspect each tool result and its immutable receipt.
6. Select **Revoke trust** when repository writes should stop.

WhiteShadow may be offline while Ollama chat and repository tools remain usable; the console reports this as degraded instead of hiding it.

Each local Ollama request has a 120-second bound, while the complete agent run remains bounded to 300 seconds. A cold first response can therefore load the installed model without creating an unbounded operation.

See [the Phase 1 operator runbook](docs/operations/phase-1-local-orchestrator.md) for API probes and recovery guidance. The source-and-proof record is in [the Phase 1 acceptance summary](docs/operations/phase-1-acceptance-summary.md).

## Portfolio rationalization

The Portfolio workspace captures eight evidence families for each source repository, derives profiles and overlap clusters, and creates one cited recommendation per source. Deterministic rules remain authoritative; two independent `qwen3:4b` passes can enrich a recommendation but cannot invent eligibility, citations, or cluster membership. Imported ChatGPT conversations are optional intent evidence and never implementation proof.

Use the explicit dashboard refresh for normal local operation. For the feature-branch acceptance gate, follow [the portfolio rationalization runbook](docs/operations/portfolio-rationalization.md) and run exactly one opt-in acceptance command:

```powershell
npm run portfolio:acceptance -- --live
```

The command requires the exact portfolio feature branch, the existing ignored `.env`, and the already-installed `qwen3:4b` model. It writes immutable evidence plus a sanitized report only under ignored `.local/` storage. It does not write to source repositories, WhiteShadow, ChatGPT, or Ollama model inventory.

## Useful commands

```powershell
npm run check:public-boundary
npm run typecheck
npm test
npm run build
npm run verify
```

The synthetic ingestion fixture writes only to ignored `.local/evidence` storage.

## Local production delivery

GitHub Actions is the release control plane for this single-machine deployment. A protected and verified `main` commit is built twice for byte-identical qualification, then packaged as an immutable GitHub Release containing the application and a separately hashed recovery controller. A repository-scoped self-hosted Windows runner installs the exact release under ignored `.local/deployment` storage on the D drive, uses a byte-for-byte verified official Node.js `v22.23.2` distribution stored on that same D-backed path, validates the complete runtime dependency tree and Windows task identity, and supervises it through a frozen last-known-good controller. Crash-recovery records keep release, Node, controller, deploy, and rollback transactions retryable without adopting incomplete files. Production acceptance commits only after both local AI backends pass an allowlisted WhiteShadow capability call and bounded real `qwen3:4b` Ollama inference. Rollback runs only that installed controller and never checks out mutable rollback scripts. The application remains available only at `http://127.0.0.1:8790`; GitHub Pages and public ingress are not part of the architecture.

See the [local production deployment runbook](docs/operations/local-production-deployment.md) for runner preparation, release verification, monitoring, and exact-SHA rollback.
