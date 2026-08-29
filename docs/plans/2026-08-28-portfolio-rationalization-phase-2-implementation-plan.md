# Portfolio Rationalization Phase 2 Implementation Plan

Date: 2026-08-28

Design: `docs/superpowers/specs/2026-08-28-portfolio-rationalization-phase-2-design.md`

Branch: `feature/portfolio-rationalization`

## Goal

Implement and verify a read-only portfolio audit, reconciliation, and rationalization experience for the captured source-repository inventory. Produce cited local recommendations without changing any source repository or copying private evidence into this public repository.

## Work package 1: Contracts and synthetic fixtures

- Add strict schemas and types for portfolio runs, checkpoints, evidence families, repository snapshots/profiles, citations, clusters, recommendations, confidence factors, decision events, and overrides.
- Add invented fixtures representing 23 source repositories with public/private, complete/incomplete, overlapping/standalone, active/inactive, renamed, permission-gap, and contradictory cases.
- Add schema and fixture tests before implementation consumers.

Checkpoint: focused contract tests, public-boundary check, typecheck.

## Work package 2: Immutable portfolio evidence

- Extend the local evidence store with typed, content-verified portfolio run and recommendation decision event operations.
- Preserve checksum sidecars, canonical JSON validation, path identity, symlink containment, idempotent identical writes, conflicting-ID rejection, and bounded listing.
- Represent checkpoints and decision changes as append-only events; derive current views rather than overwriting history.

Checkpoint: tamper, conflict, concurrency, invalid-ID, traversal, and list-bound tests.

## Work package 3: Read-only GitHub ingestion

- Add a `portfolio-ingestion` workspace with injected credential and fetch providers.
- Reject non-GET/HEAD methods before sending a request.
- Implement inventory, repository metadata, default-branch revision/tree, bounded file discovery/content, releases, commits, issues, pull requests, reviews, and comments.
- Implement pagination, ETags, rate-limit checkpoints, permission and deletion outcomes, renamed identity, and one retry for a moving HEAD.
- Store before/after ref fingerprints for live no-write proof.

Checkpoint: fake-fetch integration tests prove coverage and method/credential safety.

## Work package 4: Deterministic profiling and reconciliation

- Add a `portfolio-reconciliation` workspace.
- Extract stack, manifests, workflows, deployment surfaces, capabilities, activity, and evidence coverage deterministically.
- Normalize capabilities and compute pairwise Jaccard overlap.
- Build standalone groups and overlap clusters.
- Implement the exact action eligibility rules and confidence formula from the design.
- Add two-pass schema-constrained `qwen3:4b` classification through the existing Ollama client; require valid citations and retain deterministic authority.
- Emit recommendations, contradictions, auto-finalization events, and receipts.

Checkpoint: deterministic, classifier-disagreement, confidence-boundary, contradiction, and citation tests.

## Work package 5: ChatGPT evidence enrichment

- Extend session ingestion with atomic ChatGPT export validation and normalization.
- Map imported intent claims to repository profiles without treating them as implementation proof.
- Add an operator Playwright script and runbook for manual-login capture/verification; exclude credentials, cookies, profiles, captures, and raw exports from Git.
- Treat unavailable chats as non-blocking missing enrichment.

Checkpoint: valid, malformed, duplicate, partial, injection, redaction, and atomicity tests.

## Work package 6: API, CopilotKit, and dashboard

- Compose portfolio services into the loopback API.
- Add the approved run, repository, cluster, recommendation, override, and chat-import endpoints with strict request/response validation.
- Add sanitized evidence projection and typed CopilotKit read tools; do not expose refresh or override as model tools.
- Add Portfolio Overview, Repository Profiles, Overlap Clusters, Recommendations, Evidence and Contradictions, ChatGPT Import, and Run History views.
- Add loading, empty, incomplete, paused, degraded, blocked, and integrity-error states.

Checkpoint: API contract/integration tests and responsive component tests.

## Work package 7: Fixture CI and security gates

- Add a secret-free GitHub Actions workflow for public-boundary, typecheck, tests, and production build.
- Prove fixtures contain no real private names, credentials, paths, chat content, or source code.
- Prove GitHub access is GET/HEAD only, portfolio model tools are read-only, prompt injection cannot become policy, and raw evidence cannot cross public/browser boundaries.
- Keep live GitHub, ChatGPT, Ollama, and WhiteShadow access out of CI.

Checkpoint: clean fixture CI and local full verification.

## Work package 8: Live acceptance and closeout

- Preflight exact branch, remote, ignored evidence paths, GitHub access, Ollama model inventory, and WhiteShadow no-write boundary.
- Run one live inventory and preserve immutable source snapshots locally.
- Generate profiles, clusters, recommendations, decisions, citations, and receipts for every captured source repository.
- Compare before/after source ref fingerprints.
- Exercise dashboard and cited chat at desktop, tablet, and phone viewports.
- Record evidence-safe acceptance output and dependency/security exceptions.
- Commit coherent checkpoints, push only `feature/portfolio-rationalization`, prove local/tracking/remote equality, and refresh the durable handoff.

## Mandatory stop conditions

Stop and report if:

- any operation would write to a source repository, protected branch, WhiteShadow, model inventory, production, or shared live service;
- GitHub access cannot provide an authoritative owned-repository inventory;
- private or credential-bearing content enters a tracked candidate;
- evidence corruption or an unresolved revision mismatch makes a recommendation untraceable;
- three consecutive attempts fail, one command repeats five times without new evidence, or polling reaches the repository limit.
