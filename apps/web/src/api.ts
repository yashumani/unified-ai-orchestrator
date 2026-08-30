import type {
  AgentRunReceipt,
  RuntimeServiceState,
  RuntimeStatus,
  TrustState,
  WhiteShadowCapability
} from "@unified-ai/contracts";

export interface RepositoryStatus {
  branch: string;
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  conflictCount: number;
  entries: string[];
  protectedEntriesOmitted: boolean;
  untrackedEntriesOmitted: boolean;
  truncated: boolean;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

interface RunsResponse {
  runs: AgentRunReceipt[];
}

export interface WhiteShadowCapabilityFeed {
  available: boolean;
  status: RuntimeServiceState;
  capabilities: WhiteShadowCapability[];
}

export class OperatorApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(options: {
    message: string;
    code?: string;
    retryable?: boolean;
    status: number;
  }) {
    super(options.message);
    this.name = "OperatorApiError";
    this.code = options.code ?? "request_failed";
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

async function requestJson<T>(
  path: string,
  options: { method?: "GET" | "POST"; signal?: AbortSignal } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.method === "POST" ? { "content-type": "application/json" } : {})
    },
    ...(options.method === "POST" ? { body: "{}" } : {}),
    credentials: "omit",
    cache: "no-store",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });

  if (!response.ok) {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      // The UI uses a bounded fallback and never renders a raw response body.
    }
    throw new OperatorApiError({
      status: response.status,
      message:
        envelope.error?.message ??
        `The local API returned HTTP ${String(response.status)}.`,
      ...(envelope.error?.code === undefined
        ? {}
        : { code: envelope.error.code }),
      ...(envelope.error?.retryable === undefined
        ? {}
        : { retryable: envelope.error.retryable })
    });
  }

  return (await response.json()) as T;
}

export function getRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
  return requestJson<RuntimeStatus>("/api/runtime/status", {
    ...(signal === undefined ? {} : { signal })
  });
}

export function startRuntime(): Promise<RuntimeStatus> {
  return requestJson<RuntimeStatus>("/api/runtime/start", { method: "POST" });
}

export function getTrustState(signal?: AbortSignal): Promise<TrustState> {
  return requestJson<TrustState>("/api/trust", {
    ...(signal === undefined ? {} : { signal })
  });
}

export function grantTrust(): Promise<TrustState> {
  return requestJson<TrustState>("/api/trust/grant", { method: "POST" });
}

export function revokeTrust(): Promise<TrustState> {
  return requestJson<TrustState>("/api/trust/revoke", { method: "POST" });
}

export function getRepositoryStatus(
  signal?: AbortSignal
): Promise<RepositoryStatus> {
  return requestJson<RepositoryStatus>("/api/repository/status", {
    ...(signal === undefined ? {} : { signal })
  });
}

export async function getRuns(signal?: AbortSignal): Promise<AgentRunReceipt[]> {
  const response = await requestJson<RunsResponse>("/api/runs?limit=12", {
    ...(signal === undefined ? {} : { signal })
  });
  return response.runs;
}

export async function getCapabilities(
  signal?: AbortSignal
): Promise<WhiteShadowCapabilityFeed> {
  return await requestJson<WhiteShadowCapabilityFeed>(
    "/api/whiteshadow/capabilities",
    { ...(signal === undefined ? {} : { signal }) }
  );
}
