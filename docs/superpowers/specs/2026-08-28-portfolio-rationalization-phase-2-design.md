# Portfolio Rationalization Phase 2 Design

Date: 2026-08-28

Repository: `yashumani/unified-ai-orchestrator`

Base commit: `54c34a1a6e98574ccc23bbc57543a7aed38f28cb`

Branch: `feature/portfolio-rationalization`

## 1. Purpose

Phase 2 adds a read-only portfolio rationalization system to the verified Phase 1 local orchestrator. It inventories the source repositories owned by the configured GitHub account, reconciles purpose and implementation evidence, identifies overlap, and produces cited consolidation recommendations through the local dashboard and CopilotKit chat.

The inventory is captured at run start. On 2026-08-28 it contains 24 owned repositories: this orchestrator and 23 source repositories. The implementation never hard-codes that count.

## 2. Safety boundary

Phase 2 may:

- call GitHub only with `GET` or `HEAD`;
- store raw snapshots and decisions under ignored local evidence;
- use the existing `qwen3:4b` model for bounded structured classification;
- ingest a user-selected ChatGPT export;
- use a manually authenticated Playwright workflow as an optional chat capture or verification path;
- append local recommendation decision events and receipts.

Phase 2 may not:

- clone, modify, archive, delete, merge, fork, or push to a source repository;
- write GitHub issues, pull requests, comments, settings, Actions state, or branches;
- copy private source into this public repository;
- automate ChatGPT credential entry or commit browser cookies;
- download, update, train, create, or delete an Ollama model;
- write to WhiteShadow;
- merge to `main` or deploy.

The existing repository mutation tools remain scoped only to Unified AI Orchestrator. Portfolio chat tools are read-only and cannot start a crawl or change a decision.

## 3. Architecture

```text
Explicit dashboard refresh
          |
          v
GET/HEAD-only GitHub adapter ----+----> immutable local snapshots
                                 |                |
ChatGPT export / manual browser -+                v
                                         deterministic profiles
                                                  |
                                                  v
                                  two-pass qwen3:4b enrichment
                                                  |
                                                  v
                                   overlap and rule evaluation
                                                  |
                                                  v
                              recommendations and decision events
                                      |                     |
                                      v                     v
                                local dashboard       CopilotKit reads
```

The evidence store remains the source of provenance. Deterministic repository facts outrank model output. Chat conversations are intent evidence and never implementation proof. A recommendation cannot cite text that is absent from a stored evidence object.

## 4. Evidence capture

Each run freezes an inventory fingerprint and captures these eight evidence families for every source repository:

1. identity: GitHub repository ID, owner, name, visibility, license, topics, archive/fork state;
2. default branch: branch name, commit SHA, and recursive tree;
3. documentation: README and bounded documentation files;
4. manifests: dependency, build, schema, and runtime manifests;
5. workflows: CI/CD and deployment configuration;
6. releases: release metadata or an explicitly verified empty result;
7. commits: up to 100 recent default-branch commits;
8. work items: every open issue and pull request with comments/reviews plus the 20 most recently updated closed items.

Pagination, ETags, rate limits, permissions, renames, deletions, empty responses, and moving branch revisions are evidence, not silent exceptions. A moving default-branch revision is retried once; a second mismatch marks the profile inconsistent.

The adapter receives credentials through an injected provider. It never returns or logs an authorization header. The HTTP client rejects any method other than `GET` or `HEAD` before a network call is made.

## 5. Repository profiles and clusters

A versioned repository profile records:

- purpose and intended audience;
- normalized capabilities;
- stack, runtime, data, interface, and deployment surfaces;
- activity and maintenance signals;
- open work and recent decisions;
- visibility and licensing constraints;
- evidence-family coverage;
- contradictions and citations bound to content hashes and locators.

Deterministic extractors populate identity, stack, runtime, workflow, dependency, and activity facts. Two independent schema-constrained Ollama passes may propose purpose, audience, capability labels, and a recommendation. Both use exact model `qwen3:4b`, 4096 context, temperature 0.2, thinking disabled, and no tools.

Pairwise normalized profiles produce standalone records or overlap clusters. Model labels may enrich a cluster but cannot create membership without deterministic overlap support.

## 6. Recommendation model

Every repository ends in one of these actions:

- `keep-standalone`
- `combine-with-peer`
- `extract-shared-component`
- `adopt-capability-into-orchestrator`
- `archive-candidate`
- `defer-insufficient-evidence`

The deterministic evaluator establishes action eligibility:

- incomplete evidence or unresolved contradictions permits only `defer-insufficient-evidence`;
- the same purpose and capability Jaccard overlap of at least 0.60 permits `combine-with-peer`;
- different purposes with at least two shared capabilities and overlap of at least 0.30 permits `extract-shared-component`;
- orchestration, evidence, knowledge, policy, or local-model-runtime capabilities may be proposed for clean-room adoption into this orchestrator;
- `archive-candidate` requires no unique capability, a clearly healthier superseding peer, no open work, and no default-branch commit in the previous 180 days;
- otherwise the eligible action is `keep-standalone`.

Private or incompatibly licensed code may inform a requirement but can never be copied. Adoption always means a separately approved clean-room implementation.

Confidence is:

```text
0.35 * required source coverage
+ 0.25 * valid citation ratio
+ 0.20 * classifier agreement
+ 0.20 * deterministic rule support
```

Classifier agreement is 1 when normalized purpose and action match, 0.5 when purpose matches but action differs, and 0 otherwise. Rule support is 1 only when the proposed action is eligible. Auto-finalization requires confidence of at least 0.90, all eight evidence families queried successfully, every rationale claim cited, deterministic eligibility, and no unresolved contradiction.

Decisions are append-only events. A user override records the previous state, replacement state, reason, time, actor, supporting recommendation hash, and immutable receipt. No event performs the recommended external action.

## 7. ChatGPT enrichment

The primary path imports a user-selected ChatGPT export through a strict atomic normalizer. Invalid or partially valid exports are rejected without storing a partial conversation set.

An operator-only Playwright workflow may navigate a manually authenticated ChatGPT project to capture or verify conversations when an export is unavailable. It cannot enter credentials, extract cookies, or become a required completion dependency.

Missing chats do not reduce repository evidence coverage or block Phase 2. Available chats may corroborate intent or create an explicit contradiction.

## 8. Local interfaces

The loopback API adds:

- `POST /api/portfolio/runs`
- `GET /api/portfolio/runs/:runId`
- `GET /api/portfolio/repositories`
- `GET /api/portfolio/repositories/:repositoryId`
- `GET /api/portfolio/clusters`
- `GET /api/portfolio/clusters/:clusterId`
- `GET /api/portfolio/recommendations`
- `GET /api/portfolio/recommendations/:recommendationId`
- `POST /api/portfolio/recommendations/:recommendationId/override`
- `POST /api/portfolio/chat-imports`

The browser receives sanitized profiles, bounded evidence excerpts, citations, confidence factors, contradictions, decision history, and receipts. Raw private evidence and credentials never cross the API boundary.

CopilotKit receives typed read-only tools to list profiles, inspect a profile, list clusters, explain overlap, retrieve recommendations, and resolve sanitized citations. Only the explicit dashboard refresh endpoint may start GitHub ingestion.

## 9. User experience

The existing control center gains:

- Portfolio Overview
- Repository Profiles
- Overlap Clusters
- Recommendations
- Evidence and Contradictions
- ChatGPT Import
- Run History and Receipts

Every recommendation displays the repository revisions, evidence coverage, citations, confidence factors, chat coverage, contradictions, deterministic eligibility, and decision status. Filters cover visibility, completeness, cluster, recommendation, confidence gate, and contradiction state.

## 10. Failure behavior

- Missing GitHub access blocks the run before storing a false inventory.
- Rate limiting creates a resumable checkpoint with the reset time.
- A repository permission gap produces an incomplete profile that cannot auto-finalize.
- A renamed repository retains identity through its immutable GitHub repository ID.
- A deleted repository becomes an explicit unavailable inventory item.
- A malformed chat import is rejected atomically.
- Ollama downtime preserves deterministic profiles and defers classification.
- Classifier disagreement prevents the 0.90 auto-finalization gate.
- Missing citations or evidence corruption blocks recommendation publication.
- Prompt-injection text is stored as untrusted evidence and never becomes policy or executable instruction.

## 11. Verification and acceptance

Fixture CI runs public-boundary, typecheck, unit/integration/security tests, and the production build without credentials, private evidence, GitHub network calls, Ollama, or WhiteShadow.

Live acceptance requires:

1. the captured inventory identifies this orchestrator and every source repository;
2. every source has a complete profile or explicit incomplete reason;
3. every source belongs to a cluster or standalone group;
4. every source has a recommendation or evidence-based defer record;
5. citations resolve to immutable objects and valid locators;
6. auto-finalization follows the exact confidence gate;
7. overrides are append-only and receipt-backed;
8. the dashboard and cited chat work at desktop, tablet, and phone sizes;
9. before/after source-repository ref fingerprints are identical;
10. the feature branch is clean, verified, pushed, and equal to its remote ref.

Deployment, source-repository changes, actual consolidation, archival, and a merge to `main` remain separate approvals.
