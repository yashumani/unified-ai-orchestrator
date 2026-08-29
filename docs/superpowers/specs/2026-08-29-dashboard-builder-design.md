# Dashboard Builder Phase 3 Design

Date: 2026-08-29

Repository: `yashumani/unified-ai-orchestrator`

Base commit: `9ef2d04de238ea9d0d616b3187b1b77947a1618d`

Branch: `feature/dashboard-builder`

## 1. Purpose

Phase 3 adds a self-service dashboard builder to Unified AI Orchestrator. A user can download an owned sample template, upload it unchanged or edit its parameters, validate it, preview a working React dashboard immediately, publish an immutable revision, download it again, and roll back to an earlier revision.

The product is based on a versioned declarative dashboard manifest. The manifest describes parameters, data bindings, dimensions, measures, calculations, tables, visual components, layout, theme tokens, and interactions. It does not contain executable React, JavaScript, HTML, CSS, package declarations, credentials, or vendor extension code.

The initial runtime renders bundled React components from an allowlisted registry. Qlik-backed execution is the first production data runtime and evaluates Qlik expressions and associative selections when an authorized Qlik connection is configured. A deterministic fixture adapter keeps the complete sample workflow usable and testable locally and in CI without Qlik credentials.

## 2. Product boundary

Phase 3 includes:

- a tracked, synthetic sample dashboard manifest and fixture dataset;
- sample download and strict JSON upload;
- form-based editing plus a synchronized JSON view;
- schema and semantic validation with actionable diagnostics;
- an instant draft preview using bundled React components;
- immutable draft, publish, download, revision-history, and rollback operations;
- deterministic portable calculations represented as a safe expression tree;
- Qlik-backed calculation and selection ports with server-only credentials;
- responsive workspace navigation, builder, preview, diagnostics, and history views;
- content-addressed local persistence and evidence-safe receipts.

Phase 3 does not include:

- execution of uploaded JSX, JavaScript, TypeScript, HTML, CSS, WebAssembly, or SQL;
- dynamic `import()`, `eval`, `Function`, package installation, or user-selected React modules;
- upload or redistribution of Vizlib extension ZIPs, Vizlib assets, or proprietary Vizlib templates;
- automatic conversion of a `.qvf` file or undocumented Vizlib property blob;
- browser-held Qlik credentials or direct browser authority over a Qlik tenant;
- full emulation of the Qlik calculation engine in JavaScript;
- deployment, public hosting, protected-branch merge, or standalone project export in this phase.

Standalone React project export remains a later consumer of the same manifest and component registry. It must not be implemented by generating or compiling uploaded code.

## 3. Why the neutral manifest is required

A Qlik visualization is a generic object whose data definition commonly includes a hypercube. Qlik Engine evaluates dimensions, measures, expressions, totals, and selections; the extension renders the resulting layout. Vizlib templates apply saved properties to supported Vizlib objects, but their public workflow is not a portable React application contract.

The builder therefore owns a stable contract between source metadata and React rendering:

```text
Owned sample or authorized Qlik metadata
                  |
                  v
       dashboard-template/v1 JSON
                  |
       schema + semantic validation
                  |
          normalized manifest
             /             \
            v               v
 deterministic fixture   Qlik-backed adapter
            \               /
             v             v
       allowlisted React component registry
                  |
                  v
       draft preview / immutable publish
```

The neutral contract prevents undocumented vendor properties from becoming runtime dependencies and prevents uploaded content from becoming executable authority.

Relevant external boundaries:

- Qlik generic object and hypercube behavior: <https://www.qlik.dev/embed/foundational-knowledge/app-anatomy/generic-object-model/>
- Qlik extension model: <https://www.qlik.dev/extend/extensions/>
- Vizlib template workflow: <https://docs-vizlib.insightsoftware.com/hc/en-us/articles/39676014406157-Creating-and-Saving-Templates>
- Vizlib license and template restrictions: <https://insightsoftware.com/legal/vizlib-terms-and-conditions/>

## 4. Dashboard manifest

The root schema is strict and versioned as `dashboard-template/v1`.

```json
{
  "schemaVersion": "dashboard-template/v1",
  "template": {
    "templateId": "sales-overview",
    "name": "Sales overview",
    "version": "1.0.0",
    "description": "Synthetic sample dashboard"
  },
  "provenance": {
    "source": "native",
    "sourceReference": null
  },
  "runtime": {
    "preferredAdapter": "fixture",
    "fixtureId": "sales-overview-v1"
  },
  "parameters": [],
  "bindings": [],
  "calculations": [],
  "components": [],
  "interactions": [],
  "theme": {},
  "layout": {}
}
```

### 4.1 Identity and provenance

- `templateId` is a stable lowercase identifier, not a path or filename.
- `version` is semantic version text supplied by the author; immutable revision identity is assigned by the service.
- `source` is `native` or `qlik-object-metadata`.
- `sourceReference` may hold sanitized tenant/app/object identifiers needed by an authorized server adapter. It cannot contain a URL with credentials, token, cookie, extension package, or raw vendor asset.
- A `qlik-object-metadata` manifest records compatibility diagnostics. It does not claim Vizlib conversion or license permission.

### 4.2 Parameters

Parameters are typed as `string`, `number`, `boolean`, `date`, or `enum`. Each declares an identifier, label, default value, optional allowed range or choices, and whether it may affect data, display, or both. Defaults and submitted overrides must pass the same schema.

### 4.3 Bindings, dimensions, and measures

A binding names a field without including data. It declares:

- a stable binding identifier;
- source field reference;
- role: `dimension`, `measure-input`, `filter`, or `label`;
- value type and optional format;
- null handling;
- optional Qlik field or master-item reference.

Components refer to binding and calculation identifiers, never to arbitrary object paths. Every reference must resolve during semantic validation.

### 4.4 Calculations

Two calculation forms are allowed:

1. `portable`: a bounded expression tree composed of allowlisted operations such as `sum`, `count`, `min`, `max`, `average`, `difference`, `ratio`, `multiply`, `round`, and `coalesce`;
2. `qlik`: a Qlik expression string that is stored as data and sent only to the configured Qlik adapter.

Portable calculations are interpreted by owned code. They are never converted to JavaScript source. The expression tree has maximum depth, node-count, and string-length limits and must be acyclic.

Qlik calculations are never evaluated in the browser or by `eval`. Fixture preview returns an explicit `qlik-adapter-required` diagnostic for a Qlik-only calculation. A Qlik adapter may return the evaluated layout plus engine diagnostics; the browser receives only bounded results.

### 4.5 Components

The first component registry contains:

- `kpi`
- `data-table`
- `bar-chart`
- `line-chart`
- `filter`
- `text`

Each component type has its own strict configuration schema. Shared properties include component ID, title, data source, dimension/calculation references, formatting, empty state, and responsive layout. A table additionally declares column order, header, alignment, width hint, sort, total behavior, page size, and selection behavior.

The registry is a compile-time map from a known component type to a bundled React renderer and configuration schema. An unknown type is a validation error, not a dynamic module lookup.

### 4.6 Layout, theme, and interactions

Layout uses a 12-column grid with `large`, `medium`, and `small` breakpoints. Coordinates and sizes are non-negative, bounded, and validated for containment. Overlap is a warning for draft preview and a publish-blocking error when it makes a component unreachable.

Theme values are semantic tokens such as surface, text, accent, success, warning, font scale, spacing, and radius. Raw CSS, selectors, URLs, and font imports are prohibited.

Interactions are allowlisted declarations: set a filter, clear a filter, select a row, select a chart value, or navigate to another component section. Targets and binding references must resolve. No interaction can call an arbitrary URL, API, script, or repository tool.

## 5. Validation and diagnostics

Validation has two stages:

1. strict Zod parsing rejects unknown fields, wrong types, oversized strings and arrays, unsafe identifiers, and unsupported schema versions;
2. semantic validation checks unique IDs, reference integrity, calculation depth and cycles, adapter compatibility, component capability, responsive layout, interaction targets, and publish requirements.

A diagnostic contains:

- severity: `error`, `warning`, or `info`;
- stable code;
- JSON Pointer path;
- human-readable message;
- optional remediation;
- optional component, calculation, or binding identifier.

Errors block normalization and persistence. Warnings allow a draft preview but may block publish when they represent data loss, unreachable components, unresolved Qlik requirements, or external-vendor licensing uncertainty.

Upload constraints:

- JSON only; multipart form uploads remain rejected;
- maximum request body: 1 MiB;
- maximum 100 components, 100 parameters, 200 bindings, 200 calculations, and 200 interactions;
- no inline binary, image data URL, encoded archive, HTML, CSS, or package manifest;
- client checks file size before `file.text()` and the server independently enforces all limits.

Invalid input is rejected atomically. No partial draft, object, event, or receipt is stored.

## 6. Lifecycle and concurrency

The user workflow is:

1. download the tracked sample manifest;
2. upload it or create a new draft from the sample;
3. validate and normalize it;
4. edit parameters, bindings, calculations, components, layout, and theme;
5. preview against the synthetic fixture or an available Qlik adapter;
6. publish an immutable revision;
7. download any revision;
8. roll back by publishing a new event that points to a prior revision.

Draft updates use an expected revision number. A stale update returns `409 revision-conflict` with the current revision metadata and never overwrites newer work.

Publishing stores a canonical manifest object, a content hash, validation report, preview/build receipt, actor, and append-only event. Publishing identical content is idempotent. Rollback never deletes or mutates an old revision.

## 7. Persistence

The existing local evidence store is extended with dashboard template operations. User manifests remain under ignored `.local/evidence` storage and are never committed.

Tracked repository content contains only:

- strict schemas and types;
- synthetic sample manifest and fixture data;
- owned React renderers;
- deterministic tests and documentation.

Persisted records include:

- original upload hash and bounded metadata;
- normalized manifest object;
- draft revision events;
- publish and rollback events;
- validation reports;
- preview/build receipts;
- active-revision projection derived from events.

Reads verify canonical JSON and checksum sidecars. Conflicting immutable identifiers, tampering, path traversal, symlink escape, and partial writes fail closed.

## 8. Data adapters

`DashboardDataAdapter` is an injected server-side port with these responsibilities:

- report capabilities;
- validate sanitized source references and bindings;
- execute a bounded preview request;
- return rows, aggregates, selections, formatting metadata, and diagnostics;
- expose no credential or transport object to the browser.

### 8.1 Fixture adapter

The fixture adapter is always available for the owned sample, local fallback, and CI. It reads a tracked synthetic dataset, executes portable calculations deterministically, applies filters and sorting, and produces stable preview results. It is not presented as a production substitute for Qlik semantics.

### 8.2 Qlik adapter

The Qlik adapter is the first production adapter. It is disabled until server-side tenant, app, authentication, and allowlist configuration are present. It may evaluate Qlik expressions, hypercube dimensions/measures, totals, paging, and selections. It must preserve Section Access and tenant boundaries and must never persist access tokens in a manifest or receipt.

The adapter must return `unavailable`, `unauthorized`, `binding-invalid`, `expression-invalid`, `unsupported-feature`, or `rate-limited` diagnostics without inventing data. Qlik-backed preview is not accepted as live until a user-provided non-production tenant and authentication contract are verified.

### 8.3 Vizlib boundary

The builder does not parse or execute Vizlib extension code. A future authorized metadata adapter may map documented Qlik object properties into this owned manifest, but undocumented Vizlib properties and assets remain dependency-bound. Conversion, derivative use, or redistribution requires a separate licensing review and written authorization where applicable.

An existing Vizlib object can remain embedded through a Qlik-supported compatibility path, but that is still a Qlik/Vizlib runtime and not a standalone React conversion.

## 9. API

The loopback API adds:

- `GET /api/dashboard-builder/sample`
- `POST /api/dashboard-builder/imports`
- `GET /api/dashboard-builder/templates`
- `GET /api/dashboard-builder/templates/:templateId`
- `GET /api/dashboard-builder/templates/:templateId/revisions`
- `PUT /api/dashboard-builder/templates/:templateId/draft`
- `POST /api/dashboard-builder/templates/:templateId/validate`
- `POST /api/dashboard-builder/templates/:templateId/preview`
- `POST /api/dashboard-builder/templates/:templateId/publish`
- `POST /api/dashboard-builder/templates/:templateId/rollback`
- `GET /api/dashboard-builder/builds/:buildId`
- `GET /api/dashboard-builder/adapters`

Every request and response is schema-validated. Mutations use JSON and the existing loopback mutation boundary. Validation returns `422`, body limits return `413`, revision conflicts return `409`, missing records return `404`, unavailable adapters return a typed `503`, and integrity failures return an evidence-safe error without raw manifest content.

CopilotKit may receive read-only tools to inspect a template, explain a diagnostic, list revisions, and inspect a build. Import, edit, publish, and rollback remain explicit UI/API actions and are not model tools.

## 10. React experience

The application gains top-level workspace navigation instead of stacking another major feature below the existing portfolio dashboard.

The Dashboard Builder workspace contains:

- template gallery and sample download;
- upload/drop zone with pre-read size enforcement;
- builder form for identity, parameters, bindings, calculations, components, layout, interactions, and theme;
- synchronized JSON editor with parse diagnostics;
- responsive live preview;
- adapter and compatibility status;
- validation diagnostics grouped by severity and JSON path;
- publish controls with revision-conflict handling;
- revision history, download, and rollback;
- empty, loading, invalid, degraded, unavailable-adapter, conflict, integrity-error, and success states.

The preview renderer receives only a parsed normalized manifest and a typed data result. It does not render arbitrary HTML and does not use `dangerouslySetInnerHTML`.

## 11. Failure behavior

- An oversized or non-JSON upload is rejected before parsing.
- An unsupported schema version is rejected with an upgrade diagnostic.
- Unknown component or operation types are rejected.
- Broken references and calculation cycles block persistence.
- A Qlik-only calculation on the fixture adapter displays an explicit unavailable diagnostic and no fabricated value.
- Qlik authentication or tenant failure cannot expose credentials or fall through to another tenant.
- A stale editor cannot overwrite a newer revision.
- A publish interrupted before its event is durable leaves the previous active revision unchanged.
- A corrupted object or checksum blocks preview, publish, download, and rollback.
- A proprietary vendor archive or executable payload is rejected, not unpacked.
- Browser refresh reloads the derived active revision from immutable local evidence.

## 12. Security and privacy

- Uploaded input is untrusted data, never instruction or code.
- The browser has no repository, package-manager, filesystem, Qlik credential, or process-launch authority.
- All component and calculation operations are allowlisted.
- Credentials stay in injected server providers and are excluded from logs, receipts, API projections, downloads, and manifests.
- Public-boundary checks reject tracked user manifests, real tenant/app identifiers, private data, credentials, and vendor assets.
- Synthetic fixtures use invented names and values.
- Receipts contain identifiers, status, counts, hashes, and safe diagnostics, not raw uploaded content.
- Existing CSP, loopback, trust, immutable evidence, and path-containment controls remain in force.

## 13. Compatibility and versioning

`dashboard-template/v1` is immutable after release. Additive authoring features that do not change meaning may be optional fields; meaning-changing updates require a new schema version and an explicit deterministic migration.

The importer preserves the original upload hash and records the normalized manifest hash. Export produces canonical `dashboard-template/v1` JSON. Downloading the sample, uploading it unchanged, publishing it, and downloading the published revision must preserve semantic equality.

## 14. Verification and acceptance

Fixture CI must prove:

1. strict schema parsing, size/count bounds, unknown-key rejection, and malicious payload rejection;
2. semantic reference, cycle, layout, adapter-capability, and interaction validation;
3. deterministic portable calculation results and explicit Qlik-only diagnostics;
4. immutable draft/publish/rollback events, idempotency, conflicts, checksums, traversal resistance, and tamper detection;
5. API serialization, status codes, body limits, and no raw or credential-bearing error projection;
6. registry-only rendering with no dynamic imports, `eval`, uploaded HTML, or package installation;
7. sample download-upload-preview-publish-download round-trip;
8. responsive builder and preview states at desktop, tablet, and phone widths;
9. public-boundary, typecheck, all tests, and production build without Qlik, Vizlib, Ollama, WhiteShadow, or private evidence.

Live local acceptance requires:

1. the sample can be downloaded and uploaded unchanged;
2. upload creates a valid draft and immediate fixture preview;
3. editing a parameter, portable calculation, table column, and layout changes the preview predictably;
4. invalid executable or unknown-component content is rejected with a precise diagnostic;
5. publish creates an immutable revision and receipt;
6. a stale revision is rejected without data loss;
7. rollback creates a new event and restores the selected prior manifest;
8. refresh restores the active revision from local evidence;
9. browser console is clean and there is no horizontal overflow at 1440x900, 1024x768, and 390x844;
10. the feature branch is clean, verified, pushed, equal to its remote ref, and Fixture CI is green.

Qlik-backed live acceptance remains a separate non-production integration gate because tenant choice, authentication, Section Access, and app/object identifiers have not been supplied. Direct Vizlib conversion or redistribution remains outside acceptance until licensing approval exists.

## 15. Implementation order

1. contracts and malicious/synthetic fixtures;
2. immutable persistence and lifecycle events;
3. fixture adapter and portable calculation interpreter;
4. validation, normalization, preview, publish, rollback, and download service;
5. loopback API and optional read-only CopilotKit tools;
6. workspace navigation, builder, JSON editor, diagnostics, renderer registry, and history UI;
7. Qlik adapter port and feature-gated transport boundary;
8. security tests, browser acceptance, documentation, push, and exact-SHA CI proof.

## 16. Mandatory stop conditions

Stop and report if:

- implementation would execute uploaded code or install uploaded packages;
- a manifest or receipt would contain credentials, private source data, or proprietary vendor assets;
- Qlik work would require an unspecified tenant, authentication flow, Section Access change, or production connection;
- Vizlib conversion would require reverse engineering or unapproved derivative/redistribution rights;
- a protected branch, deployment, shared service, or production resource would be changed;
- an integrity failure, concurrency conflict, or unsupported calculation would otherwise be hidden or replaced with invented data;
- three consecutive attempts fail, one command repeats five times without new evidence, or polling reaches the repository limit.
