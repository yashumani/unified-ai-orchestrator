import type {
  GitHubClientEvent,
  GitHubCredentialProvider,
  GitHubEtagCache,
  GitHubEtagCacheEntry,
  GitHubIngestionGap,
  GitHubLinks,
  GitHubPaginationRequest,
  GitHubPaginationResult,
  GitHubRateLimit,
  GitHubReadGap,
  GitHubReadMethod,
  GitHubReadRequest,
  GitHubReadResult,
  GitHubReadSuccess,
  PaginationCheckpoint
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.github.com/";
const DEFAULT_MAX_PAGES = 1_000;
const SENSITIVE_QUERY_NAMES = new Set([
  "access_token",
  "authorization",
  "client_secret",
  "token"
]);

export interface GitHubRestClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  credentials?: GitHubCredentialProvider;
  cache?: GitHubEtagCache;
  observer?: (event: GitHubClientEvent) => void;
  now?: () => Date;
}

export interface GitHubReadErrorLogRecord {
  name: "GitHubReadError";
  message: string;
  method: GitHubReadMethod;
  url: string;
  status: number | null;
  rateLimit: GitHubRateLimit | null;
  retryAfterMs: number | null;
}

interface GitHubReadErrorDetails {
  method: GitHubReadMethod;
  url: string;
  status: number | null;
  rateLimit: GitHubRateLimit | null;
  retryAfterMs: number | null;
}

export class GitHubReadError extends Error {
  readonly method: GitHubReadMethod;
  readonly url: string;
  readonly status: number | null;
  readonly rateLimit: GitHubRateLimit | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, details: GitHubReadErrorDetails) {
    super(message);
    this.name = "GitHubReadError";
    this.method = details.method;
    this.url = details.url;
    this.status = details.status;
    this.rateLimit = details.rateLimit;
    this.retryAfterMs = details.retryAfterMs;
  }

  toLogRecord(): GitHubReadErrorLogRecord {
    return {
      name: "GitHubReadError",
      message: this.message,
      method: this.method,
      url: this.url,
      status: this.status,
      rateLimit: this.rateLimit,
      retryAfterMs: this.retryAfterMs
    };
  }

  toJSON(): GitHubReadErrorLogRecord {
    return this.toLogRecord();
  }
}

export class MemoryGitHubEtagCache implements GitHubEtagCache {
  readonly #entries = new Map<string, GitHubEtagCacheEntry<unknown>>();

  async get<T>(url: string): Promise<GitHubEtagCacheEntry<T> | undefined> {
    return this.#entries.get(url) as GitHubEtagCacheEntry<T> | undefined;
  }

  async set<T>(url: string, entry: GitHubEtagCacheEntry<T>): Promise<void> {
    this.#entries.set(url, entry as GitHubEtagCacheEntry<unknown>);
  }
}

function emptyLinks(): GitHubLinks {
  return { next: null, previous: null, first: null, last: null };
}

function parseInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseRateLimit(headers: Headers): GitHubRateLimit | null {
  const limit = parseInteger(headers.get("x-ratelimit-limit"));
  const remaining = parseInteger(headers.get("x-ratelimit-remaining"));
  const used = parseInteger(headers.get("x-ratelimit-used"));
  const resetSeconds = parseInteger(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource")?.trim() || null;
  if (
    limit === null &&
    remaining === null &&
    used === null &&
    resetSeconds === null &&
    resource === null
  ) {
    return null;
  }
  return {
    limit,
    remaining,
    used,
    resetAt:
      resetSeconds === null ? null : new Date(resetSeconds * 1_000).toISOString(),
    resource
  };
}

export function parseRetryAfter(headers: Headers, now: Date): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value) {
    return null;
  }
  if (/^\d+$/u.test(value)) {
    return Number.parseInt(value, 10) * 1_000;
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) {
    return null;
  }
  return Math.max(0, retryAt - now.getTime());
}

function parseRawLinkHeader(value: string | null): GitHubLinks {
  const links = emptyLinks();
  if (!value) {
    return links;
  }
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/u.exec(part);
    if (!match) {
      continue;
    }
    const target = match[1];
    const relation = match[2];
    if (!target || !relation) {
      continue;
    }
    if (relation === "next") links.next = target;
    if (relation === "prev") links.previous = target;
    if (relation === "first") links.first = target;
    if (relation === "last") links.last = target;
  }
  return links;
}

function redactUrl(url: URL | string): string {
  const safe = new URL(String(url));
  for (const name of [...safe.searchParams.keys()]) {
    if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase())) {
      safe.searchParams.set(name, "REDACTED");
    }
  }
  safe.username = "";
  safe.password = "";
  return safe.href;
}

function redactCredentialFromJson(value: unknown, credential: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(credential, "[REDACTED_GITHUB_CREDENTIAL]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentialFromJson(item, credential));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(credential, "[REDACTED_GITHUB_CREDENTIAL]"),
        redactCredentialFromJson(item, credential)
      ])
    );
  }
  return value;
}

function assertReadMethod(method: string): asserts method is GitHubReadMethod {
  if (method !== "GET" && method !== "HEAD") {
    throw new TypeError("GitHub REST access is restricted to GET and HEAD.");
  }
}

function gap(
  kind: GitHubIngestionGap["kind"],
  reason: GitHubIngestionGap["reason"],
  url: string,
  status: number | null,
  detail: string,
  replacementUrl: string | null,
  retryAfterMs: number | null
): GitHubIngestionGap {
  return {
    kind,
    reason,
    url,
    status,
    detail,
    replacementUrl,
    retryAfterMs
  };
}

export class GitHubRestClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credentials: GitHubCredentialProvider | undefined;
  readonly #cache: GitHubEtagCache | undefined;
  readonly #observer: ((event: GitHubClientEvent) => void) | undefined;
  readonly #now: () => Date;

  constructor(options: GitHubRestClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (this.#baseUrl.protocol !== "https:") {
      throw new TypeError("GitHub REST baseUrl must use HTTPS.");
    }
    this.#baseUrl.username = "";
    this.#baseUrl.password = "";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credentials = options.credentials;
    this.#cache = options.cache;
    this.#observer = options.observer;
    this.#now = options.now ?? (() => new Date());
  }

  #resolveUrl(path: string): URL {
    const resolved = new URL(path, this.#baseUrl);
    if (resolved.origin !== this.#baseUrl.origin) {
      throw new TypeError("GitHub pagination and request URLs must remain on the configured API origin.");
    }
    if (resolved.username || resolved.password) {
      throw new TypeError("GitHub request URLs must not contain credentials.");
    }
    for (const name of resolved.searchParams.keys()) {
      if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase())) {
        throw new TypeError("GitHub credentials must not be passed in URL query parameters.");
      }
    }
    return resolved;
  }

  #safeLinks(linkHeader: string | null): GitHubLinks {
    const parsed = parseRawLinkHeader(linkHeader);
    return {
      next: parsed.next === null ? null : this.#resolveUrl(parsed.next).href,
      previous:
        parsed.previous === null ? null : this.#resolveUrl(parsed.previous).href,
      first: parsed.first === null ? null : this.#resolveUrl(parsed.first).href,
      last: parsed.last === null ? null : this.#resolveUrl(parsed.last).href
    };
  }

  #notify(event: GitHubClientEvent): void {
    try {
      this.#observer?.(event);
    } catch {
      // Observability must not change collection behavior.
    }
  }

  async requestJson<T = unknown>(
    request: GitHubReadRequest
  ): Promise<GitHubReadResult<T>> {
    const requestedMethod = request.method ?? "GET";
    assertReadMethod(requestedMethod);
    const method = requestedMethod;
    const target = this.#resolveUrl(request.path);
    const safeUrl = redactUrl(target);
    const cached =
      method === "GET" ? await this.#cache?.get<T>(target.href) : undefined;
    const headers = new Headers({
      accept: request.accept ?? "application/vnd.github+json",
      "user-agent": "unified-ai-portfolio-ingestion/0.1",
      "x-github-api-version": "2022-11-28"
    });
    if (cached) {
      headers.set("if-none-match", cached.etag);
    }

    let credentialToken: string | undefined;
    if (this.#credentials) {
      let token: string | undefined;
      try {
        token = await this.#credentials.getToken();
      } catch {
        const error = new GitHubReadError("GitHub credential acquisition failed.", {
          method,
          url: safeUrl,
          status: null,
          rateLimit: null,
          retryAfterMs: null
        });
        this.#notify({
          method,
          url: safeUrl,
          status: null,
          outcome: "error",
          rateLimit: null,
          retryAfterMs: null
        });
        throw error;
      }
      if (token !== undefined) {
        if (!token.trim() || /[\r\n]/u.test(token)) {
          throw new GitHubReadError("GitHub credential provider returned an invalid token.", {
            method,
            url: safeUrl,
            status: null,
            rateLimit: null,
            retryAfterMs: null
          });
        }
        credentialToken = token;
        headers.set("authorization", `Bearer ${token}`);
      }
    }

    const init: RequestInit = { method, headers, redirect: "manual" };
    if (request.signal) {
      init.signal = request.signal;
    }

    let response: Response;
    try {
      response = await this.#fetch(target.href, init);
    } catch {
      const error = new GitHubReadError("GitHub read request failed before receiving a response.", {
        method,
        url: safeUrl,
        status: null,
        rateLimit: null,
        retryAfterMs: null
      });
      this.#notify({
        method,
        url: safeUrl,
        status: null,
        outcome: "error",
        rateLimit: null,
        retryAfterMs: null
      });
      throw error;
    }

    const rateLimit = parseRateLimit(response.headers);
    let retryAfterMs = parseRetryAfter(response.headers, this.#now());
    if (
      retryAfterMs === null &&
      rateLimit?.remaining === 0 &&
      rateLimit.resetAt !== null
    ) {
      retryAfterMs = Math.max(
        0,
        Date.parse(rateLimit.resetAt) - this.#now().getTime()
      );
    }
    const etag = response.headers.get("etag") ?? cached?.etag ?? null;
    const linkHeader = response.headers.get("link") ?? cached?.linkHeader ?? null;
    const links = this.#safeLinks(linkHeader);
    const metadata = {
      status: response.status,
      url: safeUrl,
      etag,
      links,
      rateLimit,
      retryAfterMs
    };

    if (response.status === 304) {
      if (!cached) {
        const result: GitHubReadGap = {
          kind: "incomplete",
          ...metadata,
          gap: gap(
            "incomplete",
            "etag-cache-miss",
            safeUrl,
            response.status,
            "GitHub returned 304 but no cached representation is available.",
            null,
            retryAfterMs
          )
        };
        this.#notify({ method, url: safeUrl, status: response.status, outcome: result.kind, rateLimit, retryAfterMs });
        return result;
      }
      const result: GitHubReadSuccess<T> = {
        kind: "not-modified",
        ...metadata,
        data: cached.data
      };
      this.#notify({ method, url: safeUrl, status: response.status, outcome: result.kind, rateLimit, retryAfterMs });
      return result;
    }

    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      const replacementUrl =
        location === null ? null : redactUrl(new URL(location, target));
      const result: GitHubReadGap = {
        kind: "renamed",
        ...metadata,
        gap: gap(
          "renamed",
          "renamed",
          safeUrl,
          response.status,
          "GitHub reported that the requested resource moved.",
          replacementUrl,
          retryAfterMs
        )
      };
      this.#notify({ method, url: safeUrl, status: response.status, outcome: result.kind, rateLimit, retryAfterMs });
      return result;
    }

    if (response.status === 404 || response.status === 410) {
      const result: GitHubReadGap = {
        kind: "deleted",
        ...metadata,
        gap: gap(
          "deleted",
          response.status === 410 ? "deleted" : "not-found",
          safeUrl,
          response.status,
          response.status === 410
            ? "GitHub reported that the resource is gone."
            : "GitHub did not expose the requested resource.",
          null,
          retryAfterMs
        )
      };
      this.#notify({ method, url: safeUrl, status: response.status, outcome: result.kind, rateLimit, retryAfterMs });
      return result;
    }

    if (
      response.status === 429 ||
      (response.status === 403 && rateLimit?.remaining === 0)
    ) {
      const result: GitHubReadGap = {
        kind: "incomplete",
        ...metadata,
        gap: gap(
          "incomplete",
          "rate-limited",
          safeUrl,
          response.status,
          "GitHub rate limiting prevented a complete read.",
          null,
          retryAfterMs
        )
      };
      this.#notify({ method, url: safeUrl, status: response.status, outcome: result.kind, rateLimit, retryAfterMs });
      return result;
    }

    if (response.status === 401 || response.status === 403) {
      const result: GitHubReadGap = {
        kind: "permission-gap",
        ...metadata,
        gap: gap(
          "permission-gap",
          "permission-denied",
          safeUrl,
          response.status,
          "The credential does not expose the requested GitHub resource.",
          null,
          retryAfterMs
        )
      };
      this.#notify({ method, url: safeUrl, status: response.status, outcome: result.kind, rateLimit, retryAfterMs });
      return result;
    }

    if (!response.ok) {
      const error = new GitHubReadError(
        `GitHub read request failed with HTTP ${response.status}.`,
        {
          method,
          url: safeUrl,
          status: response.status,
          rateLimit,
          retryAfterMs
        }
      );
      this.#notify({ method, url: safeUrl, status: response.status, outcome: "error", rateLimit, retryAfterMs });
      throw error;
    }

    let data: T;
    try {
      data =
        method === "HEAD" || response.status === 204
          ? (null as T)
          : ((await response.json()) as T);
    } catch {
      const error = new GitHubReadError("GitHub returned an invalid JSON response.", {
        method,
        url: safeUrl,
        status: response.status,
        rateLimit,
        retryAfterMs
      });
      this.#notify({ method, url: safeUrl, status: response.status, outcome: "error", rateLimit, retryAfterMs });
      throw error;
    }

    if (credentialToken !== undefined) {
      data = redactCredentialFromJson(data, credentialToken) as T;
    }

    if (method === "GET" && etag !== null && this.#cache) {
      await this.#cache.set(target.href, { etag, data, linkHeader });
    }
    const result: GitHubReadSuccess<T> = {
      kind: "ok",
      ...metadata,
      data
    };
    this.#notify({ method, url: safeUrl, status: response.status, outcome: result.kind, rateLimit, retryAfterMs });
    return result;
  }

  async paginate<T>(
    request: GitHubPaginationRequest<T>
  ): Promise<GitHubPaginationResult<T>> {
    const maxPages = request.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw new TypeError("maxPages must be a positive integer.");
    }
    const items = [...(request.checkpoint?.items ?? [])];
    let nextUrl = request.checkpoint
      ? request.checkpoint.nextUrl
      : this.#resolveUrl(request.path).href;
    let pagesRead = request.checkpoint?.pagesRead ?? 0;
    const gaps: GitHubIngestionGap[] = [];
    const rateLimits: GitHubRateLimit[] = [];

    while (nextUrl !== null) {
      if (pagesRead >= maxPages) {
        gaps.push(
          gap(
            "incomplete",
            "pagination-limit",
            redactUrl(nextUrl),
            null,
            `Pagination exceeded the configured ${maxPages}-page limit.`,
            null,
            null
          )
        );
        return { items, complete: false, nextUrl, pagesRead, gaps, rateLimits };
      }
      const result = await this.requestJson<unknown>({
        path: nextUrl,
        ...(request.signal ? { signal: request.signal } : {})
      });
      if (result.rateLimit !== null) {
        rateLimits.push(result.rateLimit);
      }
      if (result.kind !== "ok" && result.kind !== "not-modified") {
        gaps.push(result.gap);
        return { items, complete: false, nextUrl, pagesRead, gaps, rateLimits };
      }
      if (!Array.isArray(result.data)) {
        gaps.push(
          gap(
            "incomplete",
            "invalid-response",
            result.url,
            result.status,
            "Expected a JSON array for a paginated GitHub endpoint.",
            null,
            result.retryAfterMs
          )
        );
        return { items, complete: false, nextUrl, pagesRead, gaps, rateLimits };
      }
      items.push(...(result.data as T[]));
      pagesRead += 1;
      nextUrl = result.links.next;
      if (request.onCheckpoint) {
        const checkpoint: PaginationCheckpoint<T> = {
          items: [...items],
          nextUrl,
          pagesRead
        };
        await request.onCheckpoint(checkpoint);
      }
    }

    return { items, complete: true, nextUrl: null, pagesRead, gaps, rateLimits };
  }
}

export type {
  GitHubClientEvent,
  GitHubCredentialProvider,
  GitHubEtagCache,
  GitHubEtagCacheEntry,
  GitHubPaginationRequest,
  GitHubPaginationResult,
  GitHubRateLimit,
  GitHubReadMethod,
  GitHubReadRequest,
  GitHubReadResult,
  PaginationCheckpoint
} from "./types.js";
