# Dashboard builder operations

The dashboard builder turns an owned JSON manifest into a governed React dashboard.
An operator or end user edits data bindings, calculations, components, table columns,
theme, interactions, and responsive layout as configuration. The browser renders only
the six bundled component types in the allowlisted registry: KPI, data table, bar
chart, line chart, filter, and text.

The upload is data, not application code. The builder does not accept JSX,
JavaScript, HTML, package declarations, dynamic component imports, raw style strings,
credentials, or executable URLs. Uploading a downloaded sample creates a template;
uploading the same template identifier again is handled as a revision-aware update by
the browser after it reads the current revision. Every API mutation still enforces its
own optimistic-concurrency check.

## Owned format and lifecycle

`dashboard-template/v1` is the only supported template format. The tracked example is:

```text
sources/fixtures/dashboard-builder/sales-overview.manifest.json
```

The supported lifecycle is:

1. Download or inspect the tracked sample.
2. Upload the JSON manifest through the dashboard workspace.
3. Edit the structured fields or the equivalent JSON view.
4. Resolve validation diagnostics while the current in-memory draft previews through
   the tracked synthetic fixture adapter.
5. Save the normalized draft when it is ready.
6. Publish an immutable revision.
7. Download a revision, continue editing a new draft, or create an immutable rollback
   revision from an earlier publication.

Draft saves use `expectedRevision`. A stale editor receives HTTP `409` with the
current revision and must refresh before resubmitting. Publication creates a build
receipt and immutable manifest revision; it does not overwrite an earlier revision.
Rollback also creates a new revision and retains the earlier lineage.

The loopback API surface is rooted at `/api/dashboard-builder`:

- `GET /sample`, `POST /imports`, `GET /templates`, and `GET /adapters`
- `GET /templates/:templateId` and `PUT /templates/:templateId/draft`
- `POST /templates/:templateId/validate` and
  `POST /templates/:templateId/preview`
- `POST /templates/:templateId/publish` and
  `POST /templates/:templateId/rollback`
- `GET /templates/:templateId/revisions` and
  `GET /templates/:templateId/revisions/:revisionNumber`
- `GET /builds/:buildId`

The import route preserves the original upload hash. Normalized manifests,
validation results, lifecycle events, build receipts, and import receipts are written
through the local evidence store. A restarted dashboard service reconstructs current
state by replaying and verifying the append-only event chain. An invalid chain blocks
the template instead of projecting uncertain state.

## Deterministic local acceptance

Run acceptance from the canonical repository on `feature/dashboard-builder`:

```powershell
git branch --show-current
git status --short --branch
npm run dashboard:acceptance
npx vitest run scripts/dashboard-builder-live-acceptance.test.ts
```

The runner creates one uniquely named evidence directory under `.local`, starts the
real Express dashboard routes on an operating-system-selected loopback port, and uses
the real dashboard service, evidence store, fixture adapter, validation, and response
contracts. It exercises:

- byte-for-byte tracked sample download and import;
- draft and publish validation, fixture preview, and persisted build retrieval;
- a structured edit and draft save;
- a stale-revision conflict;
- two publications and immutable revision download headers;
- rollback to the first publication;
- restart and evidence replay through a fresh API/service instance; and
- rejection of an upload containing executable-content markers.

The runner never calls an external endpoint. Qlik is constructed disabled, the
Copilot runtime and web serving are not mounted, and no Ollama, WhiteShadow, GitHub,
cloud, deployment, or production path is touched. The exact temporary evidence
directory is checked to remain below the repository `.local` boundary and is removed
after success or failure.

Successful output is a bounded JSON summary containing Boolean checks, counts, and
SHA-256 fingerprints. It excludes manifests, rows, projections, source references,
temporary paths, credentials, executable content, and underlying exception messages.
The same tracked inputs and fixed local clock produce the same summary fingerprint.

Absence of `--local`, an unexpected HTTP status, a contract mismatch, unsafe report
content, an unclean shutdown, or incomplete temporary cleanup exits nonzero. A green
local report proves the fixture-backed lifecycle only. It is not deployment evidence,
live-Qlik acceptance, a license determination, or authorization to merge.

## Qlik boundary

The default Qlik adapter is intentionally unavailable. A real integration must be a
separately approved, server-side provider with all of these controls:

- an explicit non-production enablement gate;
- a server-owned allowlist of Qlik app identifiers;
- credentials stored outside the manifest and browser;
- bounded rows, paging, selections, and provider diagnostics;
- sanitized tenant, app, object, binding, and expression metadata only; and
- focused contract, authorization, failure, and live-environment tests.

Do not place Qlik credentials, session material, URLs with credentials, or unrestricted
expressions in an uploaded template. The React client consumes normalized projections;
it does not connect directly to a Qlik engine.

## Vizlib and licensing boundary

Vizlib extensions and their exported configuration remain third-party, license-bound
inputs. This repository does not import Vizlib packages, execute Vizlib code, claim
format compatibility, convert proprietary extension files, or redistribute Vizlib
templates/assets. A downloaded Vizlib or Qlik artifact is therefore not an accepted
dashboard-builder upload.

If a future product requirement needs migration from a Vizlib dashboard, first obtain
license and redistribution approval and document the exact source-format contract.
Then map approved, non-executable metadata into a newly authored
`dashboard-template/v1` manifest at the governed adapter boundary. Keep the source
artifact outside fixtures and source control unless its ownership and redistribution
rights are explicitly established. Conversion and live-Qlik acceptance require their
own feature gate and evidence; the tracked synthetic fixture cannot substitute for
either.

## Operator checks and failure response

Before and after local acceptance, preserve these outputs:

```powershell
git status --short --branch
git diff --check
npm run check:public-boundary
npm run typecheck
```

If import or validation returns `422`, review the structured diagnostics in the
workspace and correct the owned manifest; do not bypass schema validation. If a draft
save returns `409`, refresh and deliberately reapply the edit against the current
revision. If the fixture adapter is unavailable or a build fails, stop and inspect the
local configuration and evidence receipt. If replay reports integrity failure, leave
the template blocked and investigate the evidence chain instead of deleting or
rewriting it.

Do not enable Qlik, add a provider, change shared infrastructure, or deploy as a repair
for a local fixture acceptance failure. Those are separate, explicitly authorized
operations.
