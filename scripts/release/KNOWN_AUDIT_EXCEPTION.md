# Controlled production audit exception

Exception ID: `copilotkit-google-vertex-undici-2026-08-29`

This release lane accepts one high-severity production dependency finding only while
all of the following remain true:

- the application is deployed only to the loopback-bound, single-operator Windows runtime;
- `apps/api` pins `@copilotkit/runtime@1.69.3`;
- the locked vulnerable chain remains
  `@copilotkit/runtime@1.69.3` -> `@ai-sdk/google-vertex@3.0.170` ->
  `@ai-sdk/openai-compatible@1.0.52` / `@ai-sdk/provider-utils@3.0.35` ->
  `undici@5.29.0`;
- the vulnerable `undici` package remains transitive at exactly the two allowlisted
  `node_modules` paths;
- the high-severity advisory source IDs remain exactly `1114638`, `1114640`, and
  `1121245`; and
- `npm audit --omit=dev` reports zero critical vulnerabilities and no other
  high-severity package.

The executable gate is `check-npm-audit.mjs`. It fails closed if the package graph,
advisories, severity, paths, or pin changes. This exception does not authorize a
public or cloud deployment and must be removed when a compatible stable CopilotKit
dependency graph resolves the affected `undici` version.

Recorded: 2026-08-29. Re-review no later than 2026-09-29 or on any dependency update,
whichever happens first.
