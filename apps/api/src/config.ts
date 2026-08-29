import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import { PINNED_OLLAMA_MODEL } from "@unified-ai/contracts";

export const CANONICAL_REPOSITORY_ROOT =
  "D:\\Yashu-AI-Workspace\\unified-ai-orchestrator";
export const CANONICAL_OLLAMA_EXECUTABLE =
  "C:\\Users\\yashu\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
export const CANONICAL_WHITESHADOW_WORKSPACE =
  "D:\\whiteshadow-workspace\\local-llm-ws";
export const CANONICAL_WHITESHADOW_PYTHON =
  "D:\\whiteshadow-workspace\\local-llm-ws\\.venv\\Scripts\\python.exe";
export const CANONICAL_DEPLOYMENT_RELEASES_ROOT = win32.resolve(
  CANONICAL_REPOSITORY_ROOT,
  ".local",
  "deployment",
  "releases"
);
const PINNED_OLLAMA_URL = "http://127.0.0.1:11434";
const PINNED_WHITESHADOW_URL = "http://127.0.0.1:8787";

export interface OrchestratorConfig {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
  releaseSha?: string;
  repositoryRoot: string;
  evidenceRoot: string;
  trustGrantRelativePath: string;
  ollamaBaseUrl: string;
  ollamaExecutable: string;
  whiteshadowBaseUrl: string;
  whiteshadowWorkspace: string;
  whiteshadowPython: string;
  webDistRoot: string;
}

function parseReleaseSha(value: string): string {
  if (value === "development" || /^[0-9a-f]{40}$/u.test(value)) {
    return value;
  }
  throw new Error(
    "ORCHESTRATOR_RELEASE_SHA must be development or a lowercase 40-character Git SHA."
  );
}

function optionalString(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: string
): string {
  const value = environment[key]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

function parseHost(value: string): OrchestratorConfig["host"] {
  if (value === "127.0.0.1" || value === "::1" || value === "localhost") {
    return value;
  }
  throw new Error(
    "ORCHESTRATOR_HOST must be a loopback host (127.0.0.1, ::1, or localhost)."
  );
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error("ORCHESTRATOR_PORT must be an integer from 1 to 65535.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ORCHESTRATOR_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function absolutePath(value: string, key: string): string {
  if (!win32.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path.`);
  }
  return win32.resolve(value);
}

function pathKey(value: string): string {
  return win32.resolve(value).toLowerCase();
}

function exactPath(value: string, expected: string, key: string): string {
  const absolute = absolutePath(value, key);
  if (pathKey(absolute) !== pathKey(expected)) {
    throw new Error(`${key} is pinned to the Phase 1 canonical path.`);
  }
  return win32.resolve(expected);
}

function deploymentWebDistPath(value: string): string {
  const absolute = absolutePath(value, "ORCHESTRATOR_WEB_DIST_ROOT");
  const developmentWebDist = win32.resolve(
    CANONICAL_REPOSITORY_ROOT,
    "apps",
    "web",
    "dist"
  );
  if (pathKey(absolute) === pathKey(developmentWebDist)) {
    return developmentWebDist;
  }
  const relativePath = win32
    .relative(CANONICAL_DEPLOYMENT_RELEASES_ROOT, absolute)
    .replaceAll("\\", "/");
  const segments = relativePath.split("/");
  if (
    segments.length !== 4 ||
    !/^[0-9a-f]{40}$/u.test(segments[0] ?? "") ||
    segments[1] !== "apps" ||
    segments[2] !== "web" ||
    segments[3] !== "dist"
  ) {
    throw new Error(
      "ORCHESTRATOR_WEB_DIST_ROOT must be the canonical development bundle or an exact deployment release bundle."
    );
  }
  return win32.resolve(CANONICAL_DEPLOYMENT_RELEASES_ROOT, ...segments);
}

function assertReleaseWebDistPair(releaseSha: string, webDistRoot: string): void {
  const developmentWebDist = win32.resolve(
    CANONICAL_REPOSITORY_ROOT,
    "apps",
    "web",
    "dist"
  );
  const expectedWebDist =
    releaseSha === "development"
      ? developmentWebDist
      : win32.resolve(
          CANONICAL_DEPLOYMENT_RELEASES_ROOT,
          releaseSha,
          "apps",
          "web",
          "dist"
        );
  if (pathKey(webDistRoot) !== pathKey(expectedWebDist)) {
    throw new Error(
      "ORCHESTRATOR_RELEASE_SHA and ORCHESTRATOR_WEB_DIST_ROOT must identify the same release."
    );
  }
}

function loopbackHttpUrl(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid loopback HTTP URL.`);
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${key} must be a credential-free loopback HTTP URL.`);
  }
  return url.toString().replace(/\/$/u, "");
}

export function loadOptionalEnvironmentFile(
  repositoryRoot: string = process.cwd()
): boolean {
  const path = resolve(repositoryRoot, ".env");
  if (!existsSync(path)) {
    return false;
  }
  process.loadEnvFile(path);
  return true;
}

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): OrchestratorConfig {
  const repositoryRoot = exactPath(
    win32.resolve(
      cwd,
      optionalString(environment, "ORCHESTRATOR_REPOSITORY_ROOT", ".")
    ),
    CANONICAL_REPOSITORY_ROOT,
    "ORCHESTRATOR_REPOSITORY_ROOT"
  );
  const evidenceRoot = exactPath(
    win32.resolve(
      repositoryRoot,
      optionalString(environment, "ORCHESTRATOR_EVIDENCE_ROOT", ".local/evidence")
    ),
    win32.resolve(CANONICAL_REPOSITORY_ROOT, ".local", "evidence"),
    "ORCHESTRATOR_EVIDENCE_ROOT"
  );
  const trustRoot = optionalString(
    environment,
    "ORCHESTRATOR_TRUST_ROOT",
    ".local/trust"
  ).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    trustRoot.length === 0 ||
    isAbsolute(trustRoot) ||
    win32.isAbsolute(trustRoot) ||
    trustRoot.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("ORCHESTRATOR_TRUST_ROOT must be a safe repository-relative path.");
  }
  if (trustRoot.toLowerCase() !== ".local/trust") {
    throw new Error("ORCHESTRATOR_TRUST_ROOT is pinned to .local/trust in Phase 1.");
  }

  const configuredModel = optionalString(
    environment,
    "OLLAMA_MODEL",
    PINNED_OLLAMA_MODEL
  );
  if (configuredModel !== PINNED_OLLAMA_MODEL) {
    throw new Error(`OLLAMA_MODEL must remain pinned to ${PINNED_OLLAMA_MODEL}.`);
  }

  const whiteshadowWorkspace = exactPath(
    optionalString(
      environment,
      "WHITESHADOW_WORKSPACE",
      CANONICAL_WHITESHADOW_WORKSPACE
    ),
    CANONICAL_WHITESHADOW_WORKSPACE,
    "WHITESHADOW_WORKSPACE"
  );

  const releaseSha = parseReleaseSha(
    optionalString(environment, "ORCHESTRATOR_RELEASE_SHA", "development")
  );
  const webDistRoot = deploymentWebDistPath(
    optionalString(
      environment,
      "ORCHESTRATOR_WEB_DIST_ROOT",
      win32.resolve(CANONICAL_REPOSITORY_ROOT, "apps", "web", "dist")
    )
  );
  assertReleaseWebDistPair(releaseSha, webDistRoot);
  return {
    host: parseHost(optionalString(environment, "ORCHESTRATOR_HOST", "127.0.0.1")),
    port: parsePort(optionalString(environment, "ORCHESTRATOR_PORT", "8790")),
    releaseSha,
    repositoryRoot,
    evidenceRoot,
    trustGrantRelativePath: `${trustRoot}/workspace-grant.json`,
    ollamaBaseUrl: (() => {
      const url = loopbackHttpUrl(
        optionalString(environment, "OLLAMA_BASE_URL", PINNED_OLLAMA_URL),
        "OLLAMA_BASE_URL"
      );
      if (url !== PINNED_OLLAMA_URL) {
        throw new Error("OLLAMA_BASE_URL is pinned to the Phase 1 loopback endpoint.");
      }
      return url;
    })(),
    ollamaExecutable: exactPath(
      optionalString(
        environment,
        "OLLAMA_EXECUTABLE",
        CANONICAL_OLLAMA_EXECUTABLE
      ),
      CANONICAL_OLLAMA_EXECUTABLE,
      "OLLAMA_EXECUTABLE"
    ),
    whiteshadowBaseUrl: (() => {
      const url = loopbackHttpUrl(
        optionalString(environment, "WHITESHADOW_BASE_URL", PINNED_WHITESHADOW_URL),
        "WHITESHADOW_BASE_URL"
      );
      if (url !== PINNED_WHITESHADOW_URL) {
        throw new Error(
          "WHITESHADOW_BASE_URL is pinned to the Phase 1 loopback endpoint."
        );
      }
      return url;
    })(),
    whiteshadowWorkspace,
    whiteshadowPython: exactPath(
      optionalString(
        environment,
        "WHITESHADOW_PYTHON",
        CANONICAL_WHITESHADOW_PYTHON
      ),
      CANONICAL_WHITESHADOW_PYTHON,
      "WHITESHADOW_PYTHON"
    ),
    webDistRoot
  };
}

export function assertCanonicalConfigPaths(config: OrchestratorConfig): void {
  exactPath(config.repositoryRoot, CANONICAL_REPOSITORY_ROOT, "repositoryRoot");
  exactPath(
    config.evidenceRoot,
    win32.resolve(CANONICAL_REPOSITORY_ROOT, ".local", "evidence"),
    "evidenceRoot"
  );
  if (config.trustGrantRelativePath.toLowerCase() !== ".local/trust/workspace-grant.json") {
    throw new Error("trustGrantRelativePath is outside the Phase 1 trust boundary.");
  }
  exactPath(config.ollamaExecutable, CANONICAL_OLLAMA_EXECUTABLE, "ollamaExecutable");
  exactPath(
    config.whiteshadowWorkspace,
    CANONICAL_WHITESHADOW_WORKSPACE,
    "whiteshadowWorkspace"
  );
  exactPath(
    config.whiteshadowPython,
    CANONICAL_WHITESHADOW_PYTHON,
    "whiteshadowPython"
  );
  const webDistRoot = deploymentWebDistPath(config.webDistRoot);
  assertReleaseWebDistPair(config.releaseSha ?? "development", webDistRoot);
  if (
    config.ollamaBaseUrl !== PINNED_OLLAMA_URL ||
    config.whiteshadowBaseUrl !== PINNED_WHITESHADOW_URL
  ) {
    throw new Error("runtime endpoints are outside the Phase 1 loopback boundary.");
  }
}

export async function validateCanonicalRuntimePaths(
  config: OrchestratorConfig
): Promise<void> {
  assertCanonicalConfigPaths(config);
  const checks = [
    [config.repositoryRoot, "directory"],
    [config.ollamaExecutable, "file"],
    [config.whiteshadowWorkspace, "directory"],
    [config.whiteshadowPython, "file"]
  ] as const;
  for (const [path, expectedType] of checks) {
    const canonical = await realpath(path);
    if (pathKey(canonical) !== pathKey(path)) {
      throw new Error(`${path} resolves outside its pinned canonical identity.`);
    }
    const status = await lstat(canonical);
    if (
      (expectedType === "file" && !status.isFile()) ||
      (expectedType === "directory" && !status.isDirectory())
    ) {
      throw new Error(`${path} is not the required ${expectedType}.`);
    }
  }
  const developmentWebDist = win32.resolve(
    CANONICAL_REPOSITORY_ROOT,
    "apps",
    "web",
    "dist"
  );
  if (pathKey(config.webDistRoot) !== pathKey(developmentWebDist)) {
    const relativePath = win32.relative(CANONICAL_REPOSITORY_ROOT, config.webDistRoot);
    let current = CANONICAL_REPOSITORY_ROOT;
    for (const segment of relativePath.split(/[\\/]/u)) {
      current = win32.resolve(current, segment);
      const status = await lstat(current);
      if (status.isSymbolicLink()) {
        throw new Error("deployment web bundle cannot traverse a symbolic link or junction");
      }
    }
    const canonical = await realpath(config.webDistRoot);
    if (pathKey(canonical) !== pathKey(config.webDistRoot)) {
      throw new Error("deployment web bundle resolved outside its exact release path");
    }
    if (!(await lstat(canonical)).isDirectory()) {
      throw new Error("deployment web bundle must be a directory");
    }
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
