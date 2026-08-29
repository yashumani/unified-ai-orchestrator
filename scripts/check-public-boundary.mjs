import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const rules = [
  ["local-runtime", /^\.local(?:\/|$)/u],
  ["playwright-profile", /^\.playwright-cli(?:\/|$)/u],
  ["private-source", /^sources\/private(?:\/|$)/u],
  ["chatgpt-source", /^sources\/chatgpt(?:\/|$)/u],
  ["raw-data", /^data\/raw(?:\/|$)/u],
  ["raw-chat", /(?:^|\/)[^/]*\.raw-chat\.json$/iu],
  ["session-transcript", /(?:^|\/)[^/]*(?:transcript|session)[^/]*\.jsonl$/iu],
  ["database", /(?:^|\/)[^/]*\.sqlite3?$/iu],
  ["local-cache", /^(?:\.cache|\.ollama|model-cache|local-index)(?:\/|$)/u]
];

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

const dashboardFixturePathPattern =
  /^sources\/fixtures\/dashboard-builder\/(?:[^/]+\/)*[^/]+\.json$/iu;
const credentialKeyPattern =
  /^(?:access-token|refresh-token|token|password|passwd|secret|credential|credentials|authorization|cookie|api-key|client-secret)$/u;
const credentialValuePattern =
  /(?:\bbearer\s+[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\s/:]+:[^\s/@]+@)/iu;
const vendorKeyPattern = /(?:^|-)(?:qlik|vizlib|qvf|extension-zip|vendor-asset)(?:-|$)/u;
const vendorValuePattern = /(?:\bvizlib\b|\.qvf(?:\b|$)|\.zip(?:\b|$))/iu;
const executableKeyPattern =
  /^(?:jsx|tsx|js|javascript|typescript|html|css|wasm|sql|script|scripts|source-code|package|package-json|dependencies|dev-dependencies|module|modules|imports)$/u;
const executableValuePattern =
  /(?:<\/?[A-Za-z][^>]*>|\b(?:eval|function|require)\s*\(|\bimport\s*\(|data:(?:text\/html|application\/(?:javascript|wasm)|text\/css))/iu;

function normalizeKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

function objectContains(value, keyPattern, valuePattern) {
  const pending = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object") {
      if (typeof current === "string" && valuePattern.test(current)) {
        return true;
      }
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (keyPattern.test(normalizeKey(key))) {
        return true;
      }
      pending.push(child);
    }
  }

  return false;
}

function dashboardFixtureViolation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "malformed-dashboard-fixture";
  }

  if (value.schemaVersion === "dashboard-template/v1") {
    if (
      value.provenance?.source !== "native" ||
      value.provenance?.sourceReference !== null
    ) {
      return "non-native-source";
    }
    if (
      value.runtime?.preferredAdapter !== "fixture" ||
      typeof value.runtime?.fixtureId !== "string"
    ) {
      return "non-fixture-runtime";
    }
  } else if (value.schemaVersion === "dashboard-fixture/v1") {
    if (value.synthetic !== true) {
      return "not-synthetic";
    }
  } else {
    return "unsupported-dashboard-fixture";
  }

  if (objectContains(value, credentialKeyPattern, credentialValuePattern)) {
    return "credential-content";
  }
  if (objectContains(value, vendorKeyPattern, vendorValuePattern)) {
    return "vendor-asset";
  }
  if (objectContains(value, executableKeyPattern, executableValuePattern)) {
    return "executable-field";
  }

  return undefined;
}

export function findForbiddenDashboardFixtureContent(entries) {
  const violations = [];

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (!dashboardFixturePathPattern.test(path)) {
      continue;
    }

    let value;
    try {
      value = JSON.parse(entry.content);
    } catch {
      violations.push({ path, rule: "malformed-dashboard-fixture" });
      continue;
    }

    const rule = dashboardFixtureViolation(value);
    if (rule !== undefined) {
      violations.push({ path, rule });
    }
  }

  return violations;
}

export function findForbiddenPaths(paths) {
  const violations = [];

  for (const originalPath of paths) {
    const path = normalizePath(originalPath);
    const baseName = path.split("/").at(-1) ?? "";

    if (baseName !== ".env.example" && /^\.env(?:\.|$)/u.test(baseName)) {
      violations.push({ path, rule: "environment-file" });
      continue;
    }

    for (const [rule, pattern] of rules) {
      if (pattern.test(path)) {
        violations.push({ path, rule });
        break;
      }
    }
  }

  return violations;
}

function candidatePaths() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "inherit"]
    }
  );

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function checkPublicBoundary(paths = candidatePaths()) {
  const dashboardEntries = paths
    .map(normalizePath)
    .filter((path) => dashboardFixturePathPattern.test(path))
    .map((path) => {
      try {
        return { path, content: readFileSync(path, "utf8") };
      } catch {
        return { path, content: "" };
      }
    });
  const violations = [
    ...findForbiddenPaths(paths),
    ...findForbiddenDashboardFixtureContent(dashboardEntries)
  ];

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`public-boundary violation [${violation.rule}]: ${violation.path}`);
    }
    return false;
  }

  console.log(`public-boundary check passed for ${paths.length} commit-candidate files`);
  return true;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
const modulePath = resolve(fileURLToPath(import.meta.url));

if (invokedPath === modulePath) {
  process.exitCode = checkPublicBoundary() ? 0 : 1;
}
