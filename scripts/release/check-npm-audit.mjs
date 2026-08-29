import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_EXCEPTION = Object.freeze({
  exceptionId: "copilotkit-google-vertex-undici-2026-08-29",
  apiDependency: Object.freeze({ name: "@copilotkit/runtime", version: "1.69.3" }),
  vertex: Object.freeze({ name: "@ai-sdk/google-vertex", version: "3.0.170" }),
  openAiCompatible: Object.freeze({ name: "@ai-sdk/openai-compatible", version: "1.0.52" }),
  providerUtils: Object.freeze({ name: "@ai-sdk/provider-utils", version: "3.0.35" }),
  vulnerablePackage: Object.freeze({ name: "undici", version: "5.29.0" }),
  vulnerableNodes: Object.freeze([
    "node_modules/@ai-sdk/google-vertex/node_modules/undici",
    "node_modules/@ai-sdk/openai-compatible/node_modules/undici"
  ]),
  knownHighAdvisorySources: Object.freeze([1114638, 1114640, 1121245])
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right), "en"));
}

function sameValues(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function packageAt(lock, path) {
  const value = lock?.packages?.[path];
  assert(value !== undefined && value !== null, `package-lock.json is missing ${path}.`);
  return value;
}

function assertVersion(lock, path, expectedVersion) {
  const value = packageAt(lock, path);
  assert(
    value.version === expectedVersion,
    `${path} changed from ${expectedVersion} to ${String(value.version)}.`
  );
  return value;
}

export function evaluateAuditReport(audit, lock, apiPackage, commitSha) {
  assert(/^[0-9a-f]{40}$/u.test(commitSha), "An exact lowercase 40-character commit SHA is required.");
  assert(audit?.auditReportVersion === 2, "npm audit report version 2 is required.");
  assert(audit?.vulnerabilities && typeof audit.vulnerabilities === "object", "npm audit vulnerabilities are missing.");
  assert(lock?.lockfileVersion === 3, "package-lock.json lockfileVersion 3 is required.");

  const metadata = audit?.metadata?.vulnerabilities;
  assert(metadata && typeof metadata === "object", "npm audit vulnerability metadata is missing.");
  assert(metadata.critical === 0, `Critical production vulnerabilities are forbidden; found ${String(metadata.critical)}.`);

  const highOrCritical = Object.entries(audit.vulnerabilities)
    .filter(([, value]) => value?.severity === "high" || value?.severity === "critical")
    .map(([name]) => name);
  assert(
    sameValues(highOrCritical, [EXPECTED_EXCEPTION.vulnerablePackage.name]),
    `Unexpected high/critical production vulnerabilities: ${highOrCritical.join(", ") || "none"}.`
  );
  assert(metadata.high === 1, `Expected exactly one high-severity package exception; found ${String(metadata.high)}.`);

  const undici = audit.vulnerabilities[EXPECTED_EXCEPTION.vulnerablePackage.name];
  assert(undici?.severity === "high", "The controlled undici exception is missing or no longer high severity.");
  assert(undici.isDirect === false, "The controlled undici exception must remain transitive.");
  assert(
    sameValues(undici.effects ?? [], [EXPECTED_EXCEPTION.providerUtils.name]),
    "The vulnerable undici reverse dependency edge changed."
  );
  assert(
    sameValues(undici.nodes ?? [], EXPECTED_EXCEPTION.vulnerableNodes),
    "The vulnerable undici installation paths changed."
  );
  const highSources = (undici.via ?? [])
    .filter((entry) => typeof entry === "object" && entry !== null && entry.severity === "high")
    .map((entry) => entry.source);
  assert(
    sameValues(highSources, EXPECTED_EXCEPTION.knownHighAdvisorySources),
    "The set of known high-severity undici advisories changed."
  );

  assert(
    apiPackage?.dependencies?.[EXPECTED_EXCEPTION.apiDependency.name] === EXPECTED_EXCEPTION.apiDependency.version,
    `apps/api must pin ${EXPECTED_EXCEPTION.apiDependency.name} ${EXPECTED_EXCEPTION.apiDependency.version}.`
  );
  const runtime = assertVersion(
    lock,
    `node_modules/${EXPECTED_EXCEPTION.apiDependency.name}`,
    EXPECTED_EXCEPTION.apiDependency.version
  );
  assert(
    runtime.dependencies?.[EXPECTED_EXCEPTION.vertex.name] === "^3.0.97",
    "The CopilotKit to Google Vertex dependency edge changed."
  );
  const vertex = assertVersion(
    lock,
    `node_modules/${EXPECTED_EXCEPTION.vertex.name}`,
    EXPECTED_EXCEPTION.vertex.version
  );
  assert(
    vertex.dependencies?.[EXPECTED_EXCEPTION.providerUtils.name] === EXPECTED_EXCEPTION.providerUtils.version,
    "The Google Vertex to provider-utils dependency edge changed."
  );
  assert(
    vertex.dependencies?.[EXPECTED_EXCEPTION.openAiCompatible.name] === EXPECTED_EXCEPTION.openAiCompatible.version,
    "The Google Vertex to openai-compatible dependency edge changed."
  );
  const openAiCompatible = assertVersion(
    lock,
    `node_modules/${EXPECTED_EXCEPTION.openAiCompatible.name}`,
    EXPECTED_EXCEPTION.openAiCompatible.version
  );
  assert(
    openAiCompatible.dependencies?.[EXPECTED_EXCEPTION.providerUtils.name] === EXPECTED_EXCEPTION.providerUtils.version,
    "The openai-compatible to provider-utils dependency edge changed."
  );

  for (const node of EXPECTED_EXCEPTION.vulnerableNodes) {
    assertVersion(lock, node, EXPECTED_EXCEPTION.vulnerablePackage.version);
    const providerPath = node.replace(/\/undici$/u, "/@ai-sdk/provider-utils");
    const provider = assertVersion(lock, providerPath, EXPECTED_EXCEPTION.providerUtils.version);
    assert(
      provider.dependencies?.undici === "^5.29.0",
      `The provider-utils to undici dependency edge changed at ${providerPath}.`
    );
  }

  return {
    accepted: true,
    commitSha,
    policy: {
      criticalAllowed: 0,
      highPackageExceptionsAllowed: 1
    },
    exception: {
      exceptionId: EXPECTED_EXCEPTION.exceptionId,
      chain: [
        `${EXPECTED_EXCEPTION.apiDependency.name}@${EXPECTED_EXCEPTION.apiDependency.version}`,
        `${EXPECTED_EXCEPTION.vertex.name}@${EXPECTED_EXCEPTION.vertex.version}`,
        `${EXPECTED_EXCEPTION.openAiCompatible.name}@${EXPECTED_EXCEPTION.openAiCompatible.version}`,
        `${EXPECTED_EXCEPTION.providerUtils.name}@${EXPECTED_EXCEPTION.providerUtils.version}`,
        `${EXPECTED_EXCEPTION.vulnerablePackage.name}@${EXPECTED_EXCEPTION.vulnerablePackage.version}`
      ],
      vulnerableNodes: [...EXPECTED_EXCEPTION.vulnerableNodes],
      knownHighAdvisorySources: [...EXPECTED_EXCEPTION.knownHighAdvisorySources]
    },
    observed: {
      info: metadata.info,
      low: metadata.low,
      moderate: metadata.moderate,
      high: metadata.high,
      critical: metadata.critical,
      total: metadata.total
    }
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith("--") && value !== undefined, "Arguments must be --name value pairs.");
    values.set(key.slice(2), value);
  }
  for (const required of ["audit", "lock", "api-package", "commit", "output"]) {
    assert(values.has(required), `Missing required --${required} argument.`);
  }
  return values;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const receipt = evaluateAuditReport(
    await readJson(args.get("audit")),
    await readJson(args.get("lock")),
    await readJson(args.get("api-package")),
    args.get("commit")
  );
  await writeFile(resolve(args.get("output")), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w"
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Production dependency audit gate rejected the release: ${message}\n`);
    process.exitCode = 1;
  });
}
