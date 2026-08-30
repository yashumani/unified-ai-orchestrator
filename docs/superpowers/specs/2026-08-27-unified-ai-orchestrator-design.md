# Unified AI Orchestrator Design

Status: Proposed specification awaiting user review

Date: 2026-08-27

Repository: `yashumani/unified-ai-orchestrator`

Canonical local path: `D:\Yashu-AI-Workspace\unified-ai-orchestrator`

Bootstrap branch: `feature/bootstrap`

## 1. Purpose

Unified AI Orchestrator is a clean, independently tracked, local-first platform for reconciling project intent with implementation evidence and then running approved capabilities through one orchestrator.

It consolidates selected concepts and publicly releasable verified code into this repository without modifying the repositories, ChatGPT conversations, or deployments used as source material.

## 2. Goal

The first release must provide one trustworthy path that can:

1. Read accessible project conversations and repository evidence without mutating either source.
2. Distinguish a discussed idea from implemented code and from a verified deployment.
3. Build a provenance-backed capability catalog for the Unified pilot.
4. Assemble only the context and capabilities authorized for the current request.
5. Route approved inference and tool work through one WhiteShadow-compatible local execution adapter.
6. Present the workflow through CopilotKit and AG-UI without giving the UI authority to bypass policy.
7. Produce an evidence receipt for every material answer, decision, and action.

## 3. Product identity and naming

| Surface | Convention |
| --- | --- |
| Product | Unified AI Orchestrator |
| Repository and folder | `unified-ai-orchestrator` |
| Short identifier | `uao` |
| TypeScript package | `@unified-ai/<name>` |
| Python module | `unified_ai.<name>` |
| Service | `uao-<name>` |
| Environment variable | `UAO_<NAME>` |
| Stable manifest identifier | lowercase kebab-case |
| Feature branch | `feature/<topic>` |
| Fix branch | `fix/<topic>` |
| Documentation branch | `docs/<topic>` |
| Commit subject | Conventional Commits, such as `feat(orchestrator): ...` |
| Release | Semantic versioning |

Names describe responsibility rather than the implementation library. A policy component remains `policy-engine` even if its internal dependency changes.

## 4. Scope

### 4.1 Included in the Unified pilot

- Read-only discovery of accessible ChatGPT project conversations.
- Read-only inspection of configured GitHub and local repositories.
- Source snapshots, hashes, and provenance receipts.
- Requirement, decision, claim, and capability extraction.
- Reconciliation statuses: `unverified`, `verified`, `contradicted`, `obsolete`, and `not-applicable`.
- One orchestrator for context, policy, workflow state, approvals, capability selection, and execution routing.
- A governed capability registry.
- A CopilotKit control-center interface using AG-UI events.
- A WhiteShadow-compatible local-model adapter.
- Local-first persistence, redacted fixtures, and deterministic offline tests.

### 4.2 Explicitly excluded from the first release

- Mutating any source repository.
- Sending messages to or modifying source ChatGPT conversations.
- Deploying to production or changing shared infrastructure.
- Automatically merging every source repository.
- Treating conversation claims as proof that code or a deployment exists.
- Running unrestricted shell commands or arbitrary model-generated tools.
- Storing credentials or authentication cookies in the repository.
- Committing raw private conversations or private repository content to GitHub.
- Creating multiple competing orchestrators or model agents.

## 5. Source authority

The orchestrator uses a strict authority order:

1. Current policy and explicit user approval.
2. Verified live repository files, commits, branches, and pull requests.
3. Fresh test, build, and deployment evidence.
4. ChatGPT conversations as intent and historical context.
5. Summaries and model-generated inferences.

Conversation text can establish what was requested or discussed. It cannot by itself establish that implementation, validation, merge, or deployment occurred.

Every extracted claim carries:

- source type;
- source identifier;
- source timestamp when available;
- content hash;
- verification status;
- evidence references;
- supersession status;
- extraction version.

## 6. Privacy and public-repository boundary

The GitHub repository is public. The following material is local-only and must be excluded from Git:

- raw ChatGPT transcripts;
- authentication cookies and browser profiles;
- tokens, credentials, and secrets;
- private repository names when disclosure has not been approved;
- private source code and patches;
- unredacted attachments;
- local absolute paths containing personal information;
- temporary indexes and model caches.

The public repository may contain:

- source-agnostic schemas and contracts;
- redacted synthetic fixtures;
- approved architecture and decision records;
- sanitized derived requirements;
- provenance structures that use opaque source identifiers;
- public-source references.

Local configuration supplies sensitive source mappings at runtime. Public artifacts use opaque IDs and disclose no private content.

Public-source code may be adopted only with compatible licensing and recorded provenance. Private-source implementations may inform requirements and architecture, but their code cannot be copied into this public repository without separate, explicit disclosure approval.

## 7. Architecture

```text
CopilotKit control center
        |
        | AG-UI events and approval responses
        v
Unified AI Orchestrator
        |-- workflow state
        |-- context assembly
        |-- capability selection
        |-- policy and approval checks
        |-- evidence receipts
        `-- execution routing
                 |
                 v
       WhiteShadow-compatible gateway
                 |
                 v
          Ollama / local model
```

### 7.1 One-orchestrator rule

Only `orchestrator-core` may decide:

- which workflow runs;
- which context enters a request;
- which capability is exposed;
- whether an action needs approval;
- which execution adapter receives the request;
- how the result is recorded.

CopilotKit is the interaction layer. WhiteShadow is an execution engine. An LLM proposes or interprets; it does not become an authorization authority.

### 7.2 Components

#### Control center

Provides conversation, shared state, evidence views, capability views, approval interrupts, and run history through CopilotKit.

Depends on the public orchestrator API and AG-UI event contract. It cannot call execution adapters directly.

#### Orchestrator core

Owns workflow state, context assembly, policy evaluation, capability resolution, approval gates, routing, and evidence receipts.

Depends only on versioned contracts and adapter interfaces.

#### Session ingestion

Reads accessible ChatGPT conversations through an authenticated connector. It stores immutable local snapshots and produces sanitized structured records.

Playwright is an optional manual-login verification path, not the primary ingestion dependency. Automated credential entry and cookie extraction are prohibited.

#### Repository evidence adapter

Reads configured repository metadata, branches, commits, pull requests, source files, and verification artifacts. It is read-only in the pilot.

#### Reconciliation engine

Matches conversation claims to repository and test evidence. It assigns statuses and generates conflicts for human review.

#### Capability registry

Stores versioned tools, skills, resources, prompts, policies, risk classes, adapters, and availability state. The runtime catalog is the authorized intersection of declared capabilities, project profile, user approval, environment policy, and adapter availability.

#### Evidence index

Stores immutable source references, hashes, verification records, decisions, and receipts. Raw sensitive content remains in the local evidence store and is never committed.

#### WhiteShadow adapter

Translates approved orchestrator requests into the canonical WhiteShadow-compatible chat and capability boundary. It queues work, enforces timeouts, and returns structured results. It does not expose unrestricted execution.

## 8. Data flow

### 8.1 Discovery and reconciliation

```text
ChatGPT conversations ----+
                          |
GitHub and local repos ----+--> immutable local snapshots
                          |              |
Tests and deployments -----+              v
                                 structured extraction
                                           |
                                           v
                                   reconciliation ledger
                                           |
                                           v
                                  human-reviewed decisions
                                           |
                                           v
                                    capability catalog
```

### 8.2 Runtime request

1. The control center sends a typed request.
2. The orchestrator loads the active project profile and policy.
3. The context assembler selects authorized, relevant, current evidence.
4. The capability registry resolves the available capability set.
5. The policy engine rejects, permits, or pauses for approval.
6. The orchestrator routes approved work to a deterministic handler or the WhiteShadow adapter.
7. The result is validated against its output contract.
8. The evidence index records a receipt.
9. AG-UI streams status, evidence, result, or approval state to CopilotKit.

## 9. Repository layout

```text
apps/
  control-center/
services/
  orchestrator/
  session-ingestion/
  evidence-index/
packages/
  contracts/
  capability-registry/
  context-assembler/
  project-profiles/
  whiteshadow-client/
projects/
  unified/
    profile/
    requirements/
    decisions/
    source-manifests/
modules/
  knowledge-core/
  query-runtime/
  conversation-runtime/
  governance-runtime/
sources/
  public/
  fixtures/
docs/
  architecture/
  decisions/
  research/
  plans/
tests/
  contract/
  integration/
  security/
  e2e/
```

`projects/unified` is configuration and reviewed product knowledge for this pilot. It is not a copy of an existing repository.

## 10. Failure handling

- Connector unavailable: retain the last immutable snapshot, label it stale, and block current-state claims.
- Authentication required: pause ingestion and request manual user action; never capture credentials.
- Source content changed during scan: discard the mixed snapshot and retry once against a stable source revision.
- Conflicting conversation and code evidence: record a conflict and prefer verified code for implementation state while preserving the conversation as intent.
- Missing test or deployment evidence: report `unverified`; do not infer success.
- Policy denial: produce a denial receipt without calling the adapter.
- Approval timeout: leave the run paused and perform no action.
- Model unavailable: retain deterministic capabilities and return a typed degradation response.
- Adapter timeout or malformed output: fail closed, record the error, and do not replay side-effectful work automatically.
- Evidence-store failure: block consequential actions because a receipt cannot be preserved.

## 11. Testing strategy

### Contract tests

- Versioned request, event, capability, policy, claim, and receipt schemas.
- Backward-compatibility checks for public contracts.

### Unit tests

- Claim extraction and status transitions.
- Authority ordering and conflict resolution.
- Capability intersection and policy decisions.
- Context selection and token budgeting.
- Redaction and public-artifact safeguards.

### Integration tests

- Connector fixtures to immutable snapshots.
- Repository evidence to reconciliation records.
- Orchestrator to WhiteShadow adapter using a local fake.
- AG-UI event ordering and approval resumes.

### Security tests

- Raw transcript and secret paths cannot enter tracked artifacts.
- Prompt-injection text remains evidence, never policy.
- Direct adapter access is rejected.
- Unauthorized capabilities are neither discoverable nor invocable.
- Consequential actions require explicit approval.

### End-to-end tests

- Ask what was decided about a capability and receive conversation and repository citations.
- Distinguish discussed, implemented, tested, merged, deployed, and currently running states.
- Pause for approval, resume once, and emit a complete receipt.
- Run a local-model query through the single orchestrator and WhiteShadow adapter.
- Exercise the CopilotKit control center at desktop, tablet, and phone viewports.

## 12. Delivery sequence

1. Bootstrap the repository and approve this specification.
2. Add the implementation plan, repository safeguards, contracts, and synthetic fixtures.
3. Implement local evidence storage and ChatGPT session ingestion.
4. Implement repository evidence ingestion and reconciliation.
5. Implement orchestrator core, capability registry, policy, and receipts.
6. Implement the CopilotKit control center and AG-UI streaming.
7. Implement the guarded WhiteShadow adapter.
8. Consolidate the first verified Unified capabilities in small, tested slices.
9. Run contract, integration, security, browser, and local-model acceptance checks.
10. Prepare a reviewed release; deployment remains a separate approval.

## 13. Acceptance criteria

The Unified pilot is complete only when:

- one orchestrator controls every runtime path;
- existing source repositories remain unchanged;
- raw private session material cannot be committed;
- a user can trace an answer from conversation intent through repository and test evidence;
- implementation status never relies on a conversation claim alone;
- every exposed capability has a version, policy, risk class, adapter, and test;
- consequential actions require explicit approval;
- CopilotKit cannot bypass the orchestrator;
- the WhiteShadow adapter uses the canonical guarded execution boundary;
- local/offline tests pass without private credentials;
- an end-to-end local-model run produces a validated evidence receipt;
- no production deployment or `main` mutation occurs without separate approval.

## 14. Design decisions

1. Clean-room consolidation is preferred over dumping source repositories into a monorepo.
2. ChatGPT sessions are intent evidence, not implementation proof.
3. The authenticated connector is the primary conversation source; Playwright is an optional verification path.
4. Raw sensitive evidence stays local because the GitHub repository is public.
5. CopilotKit owns interaction, not authorization.
6. WhiteShadow owns guarded local execution, not orchestration policy.
7. Deterministic handlers are used when an LLM is unnecessary.
8. Every material result is provenance-backed and fail-closed.
