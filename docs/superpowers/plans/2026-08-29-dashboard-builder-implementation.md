# Dashboard Builder Phase 3 Implementation Plan

Date: 2026-08-29

Approved design: `docs/superpowers/specs/2026-08-29-dashboard-builder-design.md`

Branch: `feature/dashboard-builder`

Verified base: `4da090c8f3db988a09cc4f2f8a63bb87a171f47d`

## Goal

Deliver the complete local and fixture-backed Phase 3 workflow: download the owned sample, upload or start from it, edit a strict declarative manifest, validate, preview through six bundled React renderers, save conflict-safe drafts, publish immutable revisions and receipts, download any revision, roll back, recover after refresh, and expose a separately gated Qlik adapter boundary. Do not execute uploaded code, connect to an unspecified Qlik tenant, convert Vizlib assets, deploy, or touch a protected branch.

## Settled implementation decisions

- Keep dashboard contracts in `packages/contracts/src/dashboard-builder.ts` and expose them through the `@unified-ai/contracts/dashboard-builder` subpath. The existing global contract file remains the primitive authority and does not re-export the dashboard subpath.
- Preserve the original import bytes with route-specific `express.raw()` JSON parsing before the global JSON parser. All other dashboard mutations use parsed JSON and the existing 1 MiB limit.
- Use underscore-free stable API codes from the approved design: `dashboard-validation-failed`, `revision-conflict`, `adapter-unavailable`, `evidence-integrity-failed`, and `unsupported-schema-version`. Conflict details are bounded to `templateId` and `currentRevision`.
- Add `GET /api/dashboard-builder/templates/:templateId/revisions/:revisionNumber` as the unambiguous revision download/read route.
- Validate and normalize an import completely before its first persistence write. Event append is always the final commit point; orphan content objects are harmless and never become active.
- Serialize mutations per template in-process. The immutable event ID and expected revision are the last cross-request conflict guard.
- Replay complete, non-truncated event histories on startup. Gaps, duplicate sequence numbers, broken previous-event hashes, mismatched template IDs, or unreadable referenced objects block that template.
- Portable expressions use a depth-generated bounded schema, not unbounded recursive `z.lazy()` parsing. Nodes are `literal`, `binding`, `parameter`, `calculation`, or allowlisted `operation`.
- Calculation behavior is deterministic: aggregates ignore null/non-numeric values; `sum` of an empty set is `0`; `count` counts non-null values; `min`, `max`, and `average` of an empty set are `null`; scalar arithmetic propagates `null`; division by zero returns `null` plus a stable warning; sorting is stable with original row order as the tiebreaker.
- Preview responses contain renderer-specific typed projections. The browser never receives adapter credentials, transport objects, or raw upstream layouts.
- Register `fixture` and `qlik` in a compile-time adapter map. The fixture adapter is ready. Qlik reports unavailable until a separately authorized transport and non-production configuration are injected.
- Use `?workspace=operator|portfolio|dashboard-builder` for top-level navigation. Only the active workspace is mounted, stopping hidden polling. Existing portfolio fragment anchors remain valid.
- Use form and JSON modes sharing one editor model. Invalid JSON text is preserved while the last valid manifest remains intact; preview pauses until parsing succeeds.
- Preview requests are debounced and abortable. Only the newest request may update the screen.
- No new chart, code-editor, router, state-store, Qlik, or Vizlib dependency is added.

## Frontend design direction

Subject: a local flight-control workspace for analysts configuring governed Qlik-ready React dashboards. Its single job is to make manifest lineage, validation, and published state obvious while the dashboard is edited.

Tokens:

- Hangar ink `#132238`: shell and high-confidence lifecycle state.
- Blueprint `#1C4E80`: actions, binding paths, and the 12-column preview ruler.
- Instrument cyan `#61B7C4`: adapter and live-preview signal.
- Beacon amber `#E77C3C`: publish blockers, unsaved state, and focus.
- Flight paper `#F2F5F7`: working surface.
- Go green `#2E7D5B`: validated and published states.
- Display: Bahnschrift; body: Aptos/Segoe UI; data: Cascadia Code. Reuse the existing product type system.

Layout:

```text
Desktop
+-----------------------------------------------------------------------+
| product identity                         workspace navigation          |
+-----------------------------------------------------------------------+
| Sample -> Draft rN -> Validated -> Adapter -> Published rN  [hash]    |
+----------------------------+------------------------------------------+
| template ledger / controls | 12-column preview ruler                  |
| form or JSON editor        | live allowlisted dashboard               |
| diagnostics + publish      | component inspector / adapter status     |
+----------------------------+------------------------------------------+
| immutable revision history                                            |
+-----------------------------------------------------------------------+

Phone
+---------------------------+
| workspace navigation      |
| lineage rail (wraps)      |
| template/actions          |
| form or JSON              |
| diagnostics/publish       |
| preview                   |
| revision history          |
+---------------------------+
```

Signature: the manifest lineage rail shows the real sequence Sample -> Draft -> Validated -> Fixture/Qlik preview -> Published with the current hash prefix. It echoes the existing Signal Spine but encodes actual lifecycle state. The rest of the builder stays quiet: no decorative thumbnails, gradients, glass effects, faux drag canvas, or generic card wall.

Self-critique: a simultaneous narrow form/JSON split and decorative template gallery would be generic and hard to use. Use a compact template ledger, mode switch, editor/preview pairing only where width permits, and local table scrolling. Preserve visible focus, reduced motion, semantic headings, and status text independent of color.

## Task 1: Dashboard contracts and tracked fixtures

Files:

- Add `packages/contracts/src/dashboard-builder.ts`.
- Add `packages/contracts/src/dashboard-builder.test.ts`.
- Update `packages/contracts/package.json` with `./dashboard-builder` exports.
- Add `sources/fixtures/dashboard-builder/sales-overview.manifest.json`.
- Add `sources/fixtures/dashboard-builder/sales-overview.rows.synthetic.json`.
- Update `scripts/check-public-boundary.mjs` and its test so dashboard fixtures must remain native, fixture-backed, synthetic, credential-free, vendor-asset-free, and executable-field-free.

Steps:

1. Write failing tests for strict root/component schemas, maximum lengths/counts, unknown keys, unsupported versions, bounded expression depth/node count, unsafe identifiers, malicious executable fields, typed request/response projections, and sample round-trip parsing.
2. Implement immutable `dashboard-template/v1` contracts, diagnostics, adapter status, preview projections, lifecycle records, receipts, API bodies, and safe conflict metadata.
3. Add the synthetic sales sample and rows, then prove both parse and contain no real source references.
4. Run:

   `npx vitest run packages/contracts/src/dashboard-builder.test.ts scripts/check-public-boundary.test.mjs`

5. Run:

   `npx tsc -b packages/contracts --pretty false`

## Task 2: Semantic validation and portable calculations

Files:

- Add `services/dashboard-builder/package.json` and `tsconfig.json`.
- Add `services/dashboard-builder/src/errors.ts`.
- Add `services/dashboard-builder/src/validation.ts` and tests.
- Add `services/dashboard-builder/src/portable-calculations.ts` and tests.
- Add `services/dashboard-builder/src/index.ts`.
- Update root `tsconfig.json`.

Steps:

1. Write failing tests for duplicate IDs, unresolved binding/calculation/parameter references, calculation cycles, operator arity, expression node limits, incompatible component sources, interaction targets, layout containment/overlap, publish-blocking warnings, HTML/data URL/package-shaped payloads, and precise JSON Pointer diagnostics.
2. Implement iterative preflight, strict parsing, normalization, semantic validation, stable diagnostic ordering, and publish eligibility.
3. Write failing tests for all portable operations, grouped calculations, parameter references, nulls, divide-by-zero warnings, filters, stable sorting, and cycle rejection.
4. Implement the owned interpreter without source generation, `eval`, `Function`, dynamic import, or SQL.
5. Run:

   `npx vitest run services/dashboard-builder/src/validation.test.ts services/dashboard-builder/src/portable-calculations.test.ts`

## Task 3: Data adapters and sample loader

Files:

- Add `services/dashboard-builder/src/data-adapter.ts`.
- Add `services/dashboard-builder/src/fixture-adapter.ts` and tests.
- Add `services/dashboard-builder/src/qlik-adapter.ts` and tests.
- Add `services/dashboard-builder/src/sample-loader.ts` and tests.

Steps:

1. Define the server-only `DashboardDataAdapter` port and compile-time registry.
2. Load only the two fixed tracked fixture paths beneath the verified repository root; reject traversal, symlinks/junctions, malformed JSON, or sample/fixture ID mismatch.
3. Implement fixture filtering, grouping, stable sorting, calculations, bounded paging, and renderer-specific typed projections for `kpi`, `data-table`, `bar-chart`, `line-chart`, `filter`, and `text`.
4. Implement the Qlik adapter boundary with injected transport, app allowlist, capability reporting, bounded results, and typed unavailable/unauthorized/binding/expression/unsupported/rate-limit diagnostics. Default composition injects no transport and performs no Qlik network request.
5. Prove Qlik-only calculations never fabricate fixture values.
6. Run:

   `npx vitest run services/dashboard-builder/src/sample-loader.test.ts services/dashboard-builder/src/fixture-adapter.test.ts services/dashboard-builder/src/qlik-adapter.test.ts`

## Task 4: Immutable dashboard evidence operations

Files:

- Update `services/evidence-index/src/local-evidence-store.ts` and `index.ts`.
- Add `services/evidence-index/src/dashboard-evidence.test.ts`.
- Update `services/evidence-index/package.json` and `tsconfig.json` references if needed.

Steps:

1. Write failing tests for event/build/import put/read/list, template-scoped paths, complete history, identity binding, canonical/checksum tampering, conflicting IDs, traversal, symlink/junction escape, and concurrent identical/conflicting writes.
2. Add typed checksummed operations without weakening existing evidence behavior.
3. Ensure list methods do not silently truncate lifecycle replay and only accept bounded dashboard IDs.
4. Run:

   `npx vitest run services/evidence-index/src/dashboard-evidence.test.ts services/evidence-index/src/evidence-index.test.ts`

## Task 5: Dashboard lifecycle service

Files:

- Add `services/dashboard-builder/src/dashboard-service.ts` and tests.
- Update `services/dashboard-builder/src/index.ts`.

Steps:

1. Write an in-memory evidence port and failing tests for import, update, stale conflict, validation, preview receipts, publish idempotency, revision download, rollback, refresh recovery, event ordering/hash chaining, atomic rejection, interrupted pre-event writes, and integrity-blocked templates.
2. Implement per-template serialized mutations and event-last commits.
3. Store normalized manifest, validation, preview, and receipt objects content-addressably; persist only safe identifiers, hashes, counts, statuses, actors, and diagnostics in receipts/events.
4. Rebuild projections exclusively from verified event history during initialization.
5. Run:

   `npx vitest run services/dashboard-builder/src/dashboard-service.test.ts`

## Task 6: Loopback API and composition

Files:

- Add `apps/api/src/dashboard-builder-routes.ts` and tests.
- Update `apps/api/src/app.ts`, `errors.ts`, `routes.ts`, `composition.ts`, and relevant tests.
- Update `apps/api/package.json`, `apps/api/tsconfig.json`, and `package-lock.json`.

Steps:

1. Add `PUT` to loopback CORS and mount route-specific raw JSON import parsing before global parsing.
2. Add typed 400/404/409/413/415/422/503/integrity-safe error mapping without exposing raw manifests, exception messages, credentials, or upstream payloads.
3. Implement and response-validate every approved dashboard route plus the revision-specific read/download route.
4. Construct and initialize the dashboard service with fixture and disabled-Qlik adapters in the composition root.
5. Write real ephemeral-loopback tests for sample, raw import hash, gallery, draft update, validation, preview, publish, revision download, rollback, adapters, hostile origin, non-JSON input, oversized input, conflict metadata, unavailable Qlik, and safe errors.
6. Run:

   `npx vitest run apps/api/src/dashboard-builder-routes.test.ts apps/api/src/app.test.ts`

## Task 7: Workspace shell and browser API client

Files:

- Add `apps/web/src/components/WorkspaceNavigation.tsx`.
- Add `apps/web/src/components/OperatorWorkspace.tsx`.
- Add `apps/web/src/hooks/useWorkspaceNavigation.ts` and tests.
- Update `apps/web/src/App.tsx`.
- Add `apps/web/src/dashboard-builder-api.ts` and tests.

Steps:

1. Move existing operator markup intact into its workspace.
2. Implement query-backed navigation, back/forward support, active-only mounting, dynamic skip target, and accessible current-page links.
3. Implement one dashboard request client with runtime response parsing, encoded identifiers, JSON bodies, `PUT`, raw JSON import bytes, safe errors, and blob downloads.
4. Test exact routes/methods/bodies and all typed error states.
5. Run:

   `npx vitest run apps/web/src/hooks/useWorkspaceNavigation.test.tsx apps/web/src/dashboard-builder-api.test.ts`

## Task 8: Editor, preview registry, and lifecycle UI

Files:

- Add reducer/hooks and dashboard components under `apps/web/src/hooks` and `apps/web/src/components/dashboard-builder`.
- Add the six renderer components and compile-time registry under `apps/web/src/components/dashboard-renderers`.
- Add `apps/web/src/dashboard-builder.css` and import it from `main.tsx`.
- Add adjacent tests.

Steps:

1. Implement the template ledger, sample download/start action, bounded JSON upload, manifest lineage rail, adapter status, and restore-last-template behavior.
2. Implement the shared editor reducer, form/JSON synchronization, dirty state, invalid-text preservation, binding/parameter/calculation/component/layout/theme/interaction fields, and actionable diagnostics.
3. Implement debounced abortable preview using only the normalized server manifest and typed preview projections.
4. Implement all six allowlisted renderers with accessible SVG charts, local table overflow, empty states, filters, and plain-text rendering.
5. Implement save, publish gating, conflict preservation, revision download/history, rollback, and refresh recovery.
6. Add responsive styles derived from the existing flight-control tokens, including the manifest lineage rail and 12-column preview ruler. Include `select` in font/focus rules and respect reduced motion.
7. Prove there is no dynamic renderer lookup, `dangerouslySetInnerHTML`, uploaded style injection, or body-level table overflow.
8. Run:

   `npx vitest run apps/web/src`

## Task 9: Deterministic acceptance and operator documentation

Files:

- Add `scripts/dashboard-builder-live-acceptance.ts` and tests.
- Update root `package.json` with `dashboard:acceptance`.
- Add `docs/operations/dashboard-builder.md` and a bounded acceptance summary.

Steps:

1. Exercise sample load/import/preview/edit/save/publish/stale conflict/download/rollback/recovery/malicious rejection against a temporary evidence root.
2. Emit a sanitized local report containing only statuses, counts, stable IDs, hashes, and diagnostic codes.
3. Document local start, the JSON contract, sample workflow, Qlik gating, Vizlib boundary, recovery, and troubleshooting.
4. Run:

   `npm run dashboard:acceptance`

## Task 10: Full verification and browser acceptance

Steps:

1. Run `git diff --check` and inspect the complete diff for secret, vendor-asset, executable-upload, path, and architecture drift.
2. Run `npm run check:public-boundary`.
3. Run `npm run typecheck`.
4. Run all focused dashboard tests.
5. Run `npm run verify` and require public-boundary, typecheck, every Vitest file/test, and production build to pass.
6. Use the `playwright` skill for live local browser acceptance at 1440x900, 1024x768, and 390x844. Exercise download -> upload -> edit parameter/calculation/table/layout -> preview -> publish -> stale conflict -> revision download -> rollback -> refresh. Require zero console errors/warnings and no document horizontal overflow.
7. Store screenshots outside the repository under the current Codex visualization directory.
8. Commit bounded checkpoints on `feature/dashboard-builder` only.
9. Use `finishing-a-development-branch`, push the feature branch, verify local/tracking/remote exact SHA equality, wait for Fixture CI, and require it to be green.
10. Report Qlik-backed live acceptance and Vizlib conversion as separately gated, not failed fixture acceptance.

## Mandatory stop conditions

- Stop if implementation would execute uploaded code, install packages from a manifest, expose credentials, connect to an unspecified tenant, reverse engineer Vizlib, mutate production/shared infrastructure, deploy, or touch a protected branch.
- Stop on an unplanned architectural blocker, three consecutive failed attempts, five identical commands without new evidence, ten polls, or the repository tool-call limit.
- On stop, refresh `C:\Users\yashu\.codex\handoffs\latest.md` with exact state and evidence.
