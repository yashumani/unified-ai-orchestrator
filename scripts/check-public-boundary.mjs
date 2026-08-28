import { execFileSync } from "node:child_process";
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

function trackedPaths() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "inherit"]
  });

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function checkPublicBoundary(paths = trackedPaths()) {
  const violations = findForbiddenPaths(paths);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`public-boundary violation [${violation.rule}]: ${violation.path}`);
    }
    return false;
  }

  console.log(`public-boundary check passed for ${paths.length} tracked files`);
  return true;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
const modulePath = resolve(fileURLToPath(import.meta.url));

if (invokedPath === modulePath) {
  process.exitCode = checkPublicBoundary() ? 0 : 1;
}
