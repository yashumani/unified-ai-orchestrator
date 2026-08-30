import type {
  RuntimeServiceState,
  WhiteShadowCapability
} from "@unified-ai/contracts";
import {
  listSafeCapabilities,
  resolveSafeCapability,
  type WhiteShadowSafeCapabilityId
} from "./policy.js";

const MAX_RESPONSE_BYTES = 2_000_000;
const SAFE_SUMMARY_KEYS = new Set([
  "status",
  "app",
  "mode",
  "host",
  "version",
  "model",
  "context",
  "context_length",
  "generated_at",
  "catalog_count",
  "skill_count",
  "skills_count",
  "plugin_count",
  "plugins_count",
  "capability_count",
  "capabilities_count",
  "ready"
]);

export interface WhiteShadowClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface WhiteShadowCapabilityResult {
  capabilityId: WhiteShadowSafeCapabilityId;
  checkedAt: string;
  summary: Record<string, string | number | boolean | null>;
}

function timestamp(): string {
  return new Date().toISOString();
}

function assertLoopbackBaseUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("WhiteShadow base URL must be credential-free loopback HTTP");
  }
  return url;
}

function summarize(value: unknown): Record<string, string | number | boolean | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WhiteShadow returned an unexpected response shape");
  }
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      SAFE_SUMMARY_KEYS.has(key) &&
      (typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        item === null)
    ) {
      output[key] = typeof item === "string" ? item.slice(0, 500) : item;
    }
  }

  for (const key of ["catalog", "skills", "plugins", "capabilities"]) {
    const item = (value as Record<string, unknown>)[key];
    if (Array.isArray(item)) {
      output[`${key}_count`] = item.length;
    }
  }
  return output;
}

export class WhiteShadowClient {
  readonly baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: WhiteShadowClientOptions = {}) {
    this.baseUrl = assertLoopbackBaseUrl(
      options.baseUrl ?? "http://127.0.0.1:8787"
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 3_000, 30_000));
  }

  listCapabilities(): WhiteShadowCapability[] {
    return listSafeCapabilities();
  }

  async status(): Promise<RuntimeServiceState> {
    try {
      const result = await this.invoke("health");
      return {
        service: "whiteshadow",
        phase: result.summary.status === "ok" ? "ready" : "degraded",
        endpoint: this.baseUrl.toString(),
        checkedAt: result.checkedAt,
        detail:
          result.summary.status === "ok"
            ? "WhiteShadow model-free read adapter is ready."
            : "WhiteShadow responded without an ok health status."
      };
    } catch (error) {
      return {
        service: "whiteshadow",
        phase: "offline",
        endpoint: this.baseUrl.toString(),
        checkedAt: timestamp(),
        detail:
          error instanceof Error
            ? `WhiteShadow is unavailable: ${error.message}`
            : "WhiteShadow is unavailable."
      };
    }
  }

  async invoke(capabilityId: string): Promise<WhiteShadowCapabilityResult> {
    const capability = resolveSafeCapability(capabilityId);
    if (capability === undefined) {
      throw new Error("WhiteShadow capability is not in the read-only model-free allowlist");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(new URL(capability.path, this.baseUrl), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) {
        throw new Error(`WhiteShadow returned HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error("WhiteShadow response exceeds the 2 MB limit");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("WhiteShadow response exceeds the 2 MB limit");
      }
      return {
        capabilityId: capability.capabilityId,
        checkedAt: timestamp(),
        summary: summarize(JSON.parse(text) as unknown)
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
