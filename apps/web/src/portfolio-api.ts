import { OperatorApiError } from "./api";
import type {
  ChatImportBody,
  ChatImportResponse,
  PortfolioCluster,
  PortfolioListResponse,
  PortfolioRecommendation,
  PortfolioRepository,
  PortfolioRun,
  RecommendationOverrideBody,
  RecommendationOverrideResponse,
  StartPortfolioRunResponse
} from "./portfolio-types";

interface PortfolioErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

async function requestPortfolioJson<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const method = options.method ?? "GET";
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(method === "POST" ? { "content-type": "application/json" } : {})
    },
    ...(method === "POST"
      ? { body: JSON.stringify(options.body ?? {}) }
      : {}),
    credentials: "omit",
    cache: "no-store",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });

  if (!response.ok) {
    let envelope: PortfolioErrorEnvelope = {};
    try {
      envelope = (await response.json()) as PortfolioErrorEnvelope;
    } catch {
      // Raw response bodies are intentionally not rendered in the browser.
    }
    throw new OperatorApiError({
      status: response.status,
      message:
        envelope.error?.message ??
        `The portfolio API returned HTTP ${String(response.status)}.`,
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

async function listPortfolioItems<T>(
  path: string,
  signal?: AbortSignal
): Promise<T[]> {
  const response = await requestPortfolioJson<PortfolioListResponse<T>>(path, {
    method: "GET",
    ...(signal === undefined ? {} : { signal })
  });
  return response.items;
}

export function getPortfolioRuns(signal?: AbortSignal): Promise<PortfolioRun[]> {
  return listPortfolioItems<PortfolioRun>("/api/portfolio/runs", signal);
}

export function startPortfolioRun(): Promise<StartPortfolioRunResponse> {
  return requestPortfolioJson<StartPortfolioRunResponse>("/api/portfolio/runs", {
    method: "POST",
    body: {}
  });
}

export function getPortfolioRepositories(
  signal?: AbortSignal
): Promise<PortfolioRepository[]> {
  return listPortfolioItems<PortfolioRepository>(
    "/api/portfolio/repositories",
    signal
  );
}

export function getPortfolioClusters(
  signal?: AbortSignal
): Promise<PortfolioCluster[]> {
  return listPortfolioItems<PortfolioCluster>("/api/portfolio/clusters", signal);
}

export function getPortfolioRecommendations(
  signal?: AbortSignal
): Promise<PortfolioRecommendation[]> {
  return listPortfolioItems<PortfolioRecommendation>(
    "/api/portfolio/recommendations",
    signal
  );
}

export function overridePortfolioRecommendation(
  recommendationId: string,
  body: RecommendationOverrideBody
): Promise<RecommendationOverrideResponse> {
  return requestPortfolioJson<RecommendationOverrideResponse>(
    `/api/portfolio/recommendations/${encodeURIComponent(recommendationId)}/override`,
    { method: "POST", body }
  );
}

export function importPortfolioChats(
  body: ChatImportBody
): Promise<ChatImportResponse> {
  return requestPortfolioJson<ChatImportResponse>(
    "/api/portfolio/chat-imports",
    { method: "POST", body }
  );
}
