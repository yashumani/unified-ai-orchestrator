import { describe, expect, it, vi } from "vitest";
import {
  GitHubReadError,
  GitHubRestClient,
  MemoryGitHubEtagCache,
  type GitHubReadMethod
} from "./github-rest-client.js";

function jsonResponse(
  value: unknown,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

describe("GitHubRestClient", () => {
  it("rejects every method outside GET and HEAD before reading credentials", async () => {
    const getToken = vi.fn(async () => "credential-must-not-be-read");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      credentials: { getToken },
      fetch
    });

    await expect(
      client.requestJson({
        method: "POST" as GitHubReadMethod,
        path: "/user/repos"
      })
    ).rejects.toThrow(/GET and HEAD/u);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("injects credentials only into the request and redacts thrown and loggable errors", async () => {
    const token = "synthetic-super-secret-token";
    const events: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return jsonResponse(
        { message: `upstream echoed ${token}` },
        { status: 500 }
      );
    });
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      credentials: { getToken: async () => token },
      fetch,
      observer: (event) => events.push(event)
    });

    const failure = await client
      .requestJson({ path: "/repos/synthetic-owner/source-01" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubReadError);
    expect(String(failure)).not.toContain(token);
    expect(JSON.stringify(failure)).not.toContain(token);
    expect(JSON.stringify((failure as GitHubReadError).toLogRecord())).not.toContain(
      token
    );
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("redacts an injected credential even if a successful upstream payload echoes it", async () => {
    const token = "synthetic-echoed-credential";
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      credentials: { getToken: async () => token },
      fetch: async () => jsonResponse({ echoed: `prefix:${token}:suffix` })
    });

    const result = await client.requestJson<{ echoed: string }>({ path: "/echo" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected a successful response.");
    expect(result.data.echoed).toBe("prefix:[REDACTED_GITHUB_CREDENTIAL]:suffix");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("classifies renamed, deleted, and permission-gap responses without following them", async () => {
    const methods: string[] = [];
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      fetch: async (input, init) => {
        methods.push(init?.method ?? "GET");
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/old-name")) {
          return new Response(null, {
            status: 301,
            headers: { location: "/repos/synthetic-owner/new-name" }
          });
        }
        if (path.endsWith("/deleted")) {
          return jsonResponse({ message: "not found" }, { status: 404 });
        }
        if (path.endsWith("/private-gap")) {
          return jsonResponse({ message: "forbidden" }, { status: 403 });
        }
        return new Response(null, { status: 204 });
      }
    });

    expect((await client.requestJson({ path: "/repos/synthetic-owner/old-name" })).kind).toBe("renamed");
    expect((await client.requestJson({ path: "/repos/synthetic-owner/deleted" })).kind).toBe("deleted");
    expect((await client.requestJson({ path: "/repos/synthetic-owner/private-gap" })).kind).toBe("permission-gap");
    const head = await client.requestJson({ path: "/meta", method: "HEAD" });
    expect(head.kind).toBe("ok");
    expect(methods).toEqual(["GET", "GET", "GET", "HEAD"]);
  });

  it("follows same-origin Link pagination, resumes checkpoints, and reuses ETags on 304", async () => {
    const cache = new MemoryGitHubEtagCache();
    const calls: Array<{ url: string; etag: string | null }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const etag = new Headers(init?.headers).get("if-none-match");
      calls.push({ url, etag });
      if (etag !== null) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      if (url.endsWith("page=2")) {
        return jsonResponse([{ id: 2 }], {
          headers: {
            etag: "\"page-two\"",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4998",
            "x-ratelimit-used": "2",
            "x-ratelimit-reset": "1787916000",
            "x-ratelimit-resource": "core"
          }
        });
      }
      return jsonResponse([{ id: 1 }], {
        headers: {
          etag: "\"page-one\"",
          link: '<https://api.github.test/items?page=2>; rel="next"'
        }
      });
    });
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      cache,
      fetch
    });

    const first = await client.paginate<{ id: number }>({ path: "/items?page=1" });
    expect(first.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(first.complete).toBe(true);
    expect(first.rateLimits.at(-1)?.remaining).toBe(4998);

    calls.length = 0;
    const second = await client.paginate<{ id: number }>({ path: "/items?page=1" });
    expect(second.items).toEqual(first.items);
    expect(calls).toEqual([
      { url: "https://api.github.test/items?page=1", etag: "\"page-one\"" },
      { url: "https://api.github.test/items?page=2", etag: "\"page-two\"" }
    ]);

    calls.length = 0;
    const resumed = await client.paginate<{ id: number }>({
      path: "/items?page=1",
      checkpoint: {
        items: [{ id: 1 }],
        nextUrl: "https://api.github.test/items?page=2",
        pagesRead: 1
      }
    });
    expect(resumed.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.test/items?page=2");
  });

  it("parses Retry-After and rate limits into an incomplete result without sleeping", async () => {
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      fetch: async () =>
        jsonResponse(
          { message: "slow down" },
          {
            status: 429,
            headers: {
              "retry-after": "7",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-used": "5000",
              "x-ratelimit-reset": "1787916000",
              "x-ratelimit-resource": "core"
            }
          }
        )
    });

    const result = await client.requestJson({ path: "/rate-limited" });
    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") {
      throw new Error("Expected an incomplete result.");
    }
    expect(result.gap.reason).toBe("rate-limited");
    expect(result.retryAfterMs).toBe(7_000);
    expect(result.rateLimit?.remaining).toBe(0);
  });
});
