# Unified AI Orchestrator

Unified AI Orchestrator is a local-first, evidence-backed platform that reconciles project conversations with repository and verification evidence, then routes approved work through one orchestrator.

The project is in its bootstrap phase. The approved architecture is documented in [the design specification](docs/superpowers/specs/2026-08-27-unified-ai-orchestrator-design.md), and the current delivery sequence is in [the bootstrap implementation plan](docs/plans/2026-08-27-bootstrap-implementation-plan.md).

## Public repository boundary

This repository is public. Never commit raw ChatGPT transcripts, private repository content or identifiers, credentials, browser profiles, attachments, model caches, or local evidence indexes.

Local runtime data belongs under `.local/` and is ignored by Git. Public tests use synthetic fixtures only.

## Development

Prerequisite: Node.js 22 or newer.

```powershell
npm install
npm run verify
npm run ingest:fixture
```

The fixture command writes only to the ignored local evidence directory.

## Current scope

The first vertical slice provides:

- public-repository safeguards;
- versioned provenance and reconciliation contracts;
- an immutable local evidence store;
- synthetic conversation ingestion;
- deterministic verification.

CopilotKit, AG-UI, live ChatGPT ingestion, repository connectors, and the WhiteShadow adapter follow after this boundary is proven.
