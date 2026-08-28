# Bootstrap Implementation Plan

Date: 2026-08-27
Design: `docs/superpowers/specs/2026-08-27-unified-ai-orchestrator-design.md`
Branch: `feature/bootstrap`
Status: Approved design; implementation authorized

## Objective

Deliver the first vertical slice of Unified AI Orchestrator:

1. protect a public repository from raw/private evidence;
2. define versioned runtime contracts;
3. persist immutable evidence locally with containment and integrity checks;
4. normalize a synthetic ChatGPT conversation into provenance-backed records;
5. prove the slice with build, type, unit, integration, and boundary checks.

This slice does not connect to a live ChatGPT account, mutate a source repository, call WhiteShadow, add CopilotKit, or deploy anything.

## Technology decision

- Runtime: Node.js 22 or newer.
- Language: strict TypeScript using ECMAScript modules.
- Workspace: npm workspaces.
- Runtime validation: Zod.
- Tests: Vitest.
- Persistent pilot store: immutable JSON files under a local-only directory.
- Hashing and atomic file operations: Node standard library.
- UI and model adapters: deferred until the evidence boundary is proven.

TypeScript is selected because CopilotKit and AG-UI are TypeScript-facing. WhiteShadow remains an external guarded runtime and will later be connected through a typed HTTP adapter.

## Non-negotiable boundaries

- One orchestrator will own runtime decisions.
- Raw ChatGPT content remains local-only.
- Private repository identifiers and code are not committed.
- Source repositories and conversations are read-only.
- Evidence writes must remain under an explicitly configured local root.
- Path traversal and symlink escapes fail closed.
- Existing evidence objects are immutable.
- Every stored object is content-addressed with SHA-256.
- Assistant-generated statements enter as unverified claims.
- No `main`, production, or deployment action occurs.

## Work package 1: Repository safeguards

Create:

- `.gitignore`
- `.gitattributes`
- `.editorconfig`
- `.npmrc`
- `README.md`
- `scripts/check-public-boundary.mjs`

The boundary checker must fail when a tracked path matches a forbidden raw/private pattern. It must never print file contents or secrets.

Required ignored paths include:

- `.local/`
- `.env` and `.env.*`, except `.env.example`
- `.playwright-cli/`
- `sources/private/`
- `sources/chatgpt/`
- `data/raw/`
- raw session/transcript JSONL patterns
- model caches and temporary indexes

Validation:

- boundary checker passes on the tracked repository;
- a test fixture proves a forbidden tracked path would be rejected;
- `git diff --check` passes.

## Work package 2: TypeScript workspace

Create the root npm workspace and strict compiler configuration.

Packages:

- `@unified-ai/contracts`
- `@unified-ai/evidence-index`
- `@unified-ai/session-ingestion`

Root scripts:

- `build`
- `typecheck`
- `test`
- `check:public-boundary`
- `ingest:fixture`
- `verify`

The `verify` command runs the public-boundary check, typecheck, tests, and build.

## Work package 3: Versioned contracts

Define and export runtime-validated contracts for:

- `SourceReference`
- `EvidenceEnvelope`
- `ConversationSnapshot`
- `ConversationTurn`
- `ClaimRecord`
- `EvidenceReceipt`
- reconciliation status and source-authority enums

Contract rules:

- every contract contains `schemaVersion`;
- timestamps are ISO-8601 UTC strings;
- stable identifiers are lowercase kebab-case or opaque UUID-like strings;
- hashes are lowercase SHA-256 hex strings;
- conversation-derived implementation claims default to `unverified`;
- evidence and claim source references are mandatory.

## Work package 4: Local immutable evidence index

Implement `LocalEvidenceStore` with:

- a configured absolute root;
- containment checks after path resolution;
- refusal to use the repository root as its evidence root;
- SHA-256 content addressing;
- canonical JSON serialization;
- atomic temporary-write then rename;
- immutable create semantics;
- idempotent writes for identical content;
- collision/mismatch failure;
- typed read and integrity verification;
- no logging of raw evidence content.

Storage layout:

```text
<local-root>/
  objects/<first-two-hash-characters>/<sha256>.json
  receipts/<receipt-id>.json
```

## Work package 5: Synthetic session ingestion

Add a public synthetic fixture with invented project, repository, user, and conversation data.

Implement a normalizer that:

1. validates the conversation snapshot;
2. stores the immutable source envelope;
3. extracts explicit user requirements;
4. records assistant implementation statements as unverified claims;
5. attaches source turn references and content hashes;
6. produces an evidence receipt;
7. writes only to the local evidence root.

The normalizer must not interpret text as executable instructions.

## Work package 6: Verification

Tests must cover:

- valid and invalid contract payloads;
- deterministic canonical JSON and hashing;
- path traversal rejection;
- repository-root evidence-store rejection;
- immutable/idempotent writes;
- tamper detection;
- user requirement extraction;
- assistant claim defaulting to `unverified`;
- source-turn provenance;
- prompt-injection-shaped text remaining inert data;
- forbidden public path detection;
- end-to-end synthetic fixture ingestion.

Required commands:

```powershell
npm install
npm run verify
npm run ingest:fixture
npm run verify
git diff --check
git status --short --branch
```

The second verification run ensures fixture ingestion does not mutate tracked files.

## Commit checkpoints

1. `docs(plan): add bootstrap implementation plan`
2. `chore(repo): enforce public evidence boundary`
3. `feat(contracts): add provenance and reconciliation contracts`
4. `feat(evidence): add immutable local evidence store`
5. `feat(ingestion): normalize synthetic conversation evidence`

A checkpoint may combine adjacent work when the repository remains buildable and the diff is easier to review.

## Completion gate

This slice is complete only when:

- `npm run verify` passes;
- synthetic ingestion succeeds twice idempotently;
- the local evidence output is ignored by Git;
- tracked files contain no raw/private session material;
- the worktree is clean after commit;
- exact command output, commit IDs, and remaining blockers are recorded;
- no source repository, ChatGPT conversation, `main`, or deployment was changed.
