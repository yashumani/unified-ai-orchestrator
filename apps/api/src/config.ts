import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PINNED_OLLAMA_MODEL } from "@unified-ai/contracts";

export const CANONICAL_REPOSITORY_ROOT =
  "D:\\Yashu-AI-Workspace\\unified-ai-orchestrator";
export const CANONICAL_OLLAMA_EXECUTABLE =
  "C:\\Users\\yashu\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
export const CANONICAL_WHITESHADOW_WORKSPACE =
  "D:\\whiteshadow-workspace\\local-llm-ws";
export const CANONICAL_WHITESHADOW_PYTHON =
  "D:\\whiteshadow-workspace\\local-llm-ws\\.venv\\Scripts\\python.exe";
const PINNED_OLLAMA_URL = "http://127.0.0.1:11434";
const PINNED_WHITESHADOW_URL = "http://127.0.0.1:8787";

export interface OrchestratorConfig {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
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
  if (!isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path.`);
  }
  return resolve(value);
}

function pathKey(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function exactPath(value: string, expected: string, key: string): string {
  const absolute = absolutePath(value, key);
  if (pathKey(absolute) !== pathKey(expected)) {
    throw new Error(`${key} is pinned to the Phase 1 canonical path.`);
  }
  return resolve(expected);
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
    resolve(
      cwd,
      optionalString(environment, "ORCHESTRATOR_REPOSITORY_ROOT", ".")
    ),
    CANONICAL_REPOSITORY_ROOT,
    "ORCHESTRATOR_REPOSITORY_ROOT"
  );
  const evidenceRoot = exactPath(
    resolve(
      repositoryRoot,
      optionalString(environment, "ORCHESTRATOR_EVIDENCE_ROOT", ".local/evidence")
    ),
    resolve(CANONICAL_REPOSITORY_ROOT, ".local", "evidence"),
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

  return {
    host: parseHost(optionalString(environment, "ORCHESTRATOR_HOST", "127.0.0.1")),
    port: parsePort(optionalString(environment, "ORCHESTRATOR_PORT", "8790")),
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
    webDistRoot: resolve(CANONICAL_REPOSITORY_ROOT, "apps", "web", "dist")
  };
}

export function assertCanonicalConfigPaths(config: OrchestratorConfig): void {
  exactPath(config.repositoryRoot, CANONICAL_REPOSITORY_ROOT, "repositoryRoot");
  exactPath(
    config.evidenceRoot,
    resolve(CANONICAL_REPOSITORY_ROOT, ".local", "evidence"),
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
  exactPath(
    config.webDistRoot,
    resolve(CANONICAL_REPOSITORY_ROOT, "apps", "web", "dist"),
    "webDistRoot"
  );
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
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
