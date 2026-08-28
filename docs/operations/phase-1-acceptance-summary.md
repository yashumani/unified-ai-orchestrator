# Phase 1 acceptance summary

Date: 2026-08-28

Branch: `feature/ollama-orchestration`

## Accepted scope

Phase 1 delivers a loopback-only local orchestration application powered by the existing Ollama model `qwen3:4b`. It provides streaming chat, bounded repository tools, persistent repository-scoped trust, four read-only WhiteShadow capabilities, and content-addressed run evidence.

The accepted boundary excludes protected branches, production resources, other repositories, arbitrary shell access, model installation or updates, WhiteShadow writes, and live external actions.

## Verification record

- Clean dependency installation added 1,068 packages and audited 1,080 packages in 44 minutes.
- Three complete `npm run verify` executions exited successfully: two after the final runtime and fixture changes, and one after the implementation and acceptance commits.
- The post-commit suite passed 24 test files and 218 tests in 219.13 seconds.
- The post-commit production web build transformed 9,152 modules and completed in 1 minute 53 seconds with non-blocking chunk-size warnings.
- The first two complete verification runs passed the public-boundary gate for 124 commit-candidate files. The closure and post-commit checks passed for 125 files after adding this summary.
- `git diff --check` passed.
- Final runtime probes returned API health `ok`, Ollama `ready`, WhiteShadow `ready`, the exact model `qwen3:4b`, and HTTP 200 from the production web preview.

## Governed runtime evidence

The deterministic fixture ingestion produced:

- Receipt ID: `receipt-8cd8f140e9712c448dbf5152`
- Receipt SHA-256: `2ebed94f0f070208d18244eb541a95a149da8ab50da63616a7bb63a6fc2f2db4`
- Source-object SHA-256: `3636f3a08bb928d04e1e7c62ada6153ed87441a68cbcf6288357ab6be6d84eba`

Live acceptance exercised these immutable agent-run receipts:

| Scenario | Receipt | Result |
| --- | --- | --- |
| Trusted repository mutation | `agui-run-c1a722691a90e36caafc12c4` | Allowed and recorded |
| Trusted restore | `agui-run-dbab3b4115bcaa288712e65a` | Original fixture bytes restored |
| Mutation without trust | `agui-run-0f2e48ce118147e7551aabda` | Blocked; bytes unchanged |
| Browser streaming chat | `agui-run-fca389d23dbc9c179e22d2fc` | Completed and recorded |

An independent integrity audit matched all three sampled receipt sidecars and all 19 referenced content-addressed objects. Application reads also validated checksums, schemas, run identifiers, canonical JSON, and object hashes.

## Trust and WhiteShadow boundaries

Trust was granted, revoked, proved absent through a blocked mutation, granted again, and then verified after an API restart. The final grant is permanent, matches `feature/ollama-orchestration`, and was created at `2026-08-28T09:03:50.557Z`.

WhiteShadow exposes exactly these read-only capabilities:

- `health`
- `runtime-summary`
- `skills-catalog`
- `plugins-catalog`

`capability-catalog` is deliberately excluded because it can conditionally refresh WhiteShadow-managed files. No WhiteShadow file, model inventory, or training state was changed.

## Browser acceptance

The production preview passed desktop and 390 by 844 viewport checks. The final browser session reported zero console errors, zero console warnings, and no horizontal overflow at the narrow viewport.

## Dependency advisory disposition

`npm audit` reports four low, one moderate, one high, and zero critical advisories. They are transitive dependencies in bundled cloud-provider paths that Phase 1 does not use for its local-Ollama execution path. `npm audit fix --dry-run` proposed zero non-breaking changes. A forced major-version update was intentionally not applied; this upstream dependency risk remains recorded for a separately tested upgrade.

## Release boundary

Acceptance is limited to the feature branch. Phase 1 did not merge or write to `main`, modify another repository, change production or shared infrastructure, download or update an Ollama model, or write to WhiteShadow. The final feature commit and remote equality are recorded in the closeout handoff after the commit is created.
