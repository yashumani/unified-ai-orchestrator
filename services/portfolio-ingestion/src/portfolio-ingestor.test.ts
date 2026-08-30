import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GitHubRestClient } from "./github-rest-client.js";
import { GitHubPortfolioIngestor } from "./portfolio-ingestor.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function encodedFile(path: string, content: string): Record<string, unknown> {
  return {
    type: "file",
    path,
    sha: `file-${path}`,
    size: Buffer.byteLength(content),
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64")
  };
}

describe("GitHubPortfolioIngestor", () => {
  it("ingests the governed surface and retries a moving default-branch HEAD once", async () => {
    const credential = "synthetic-ingestion-credential";
    const methods: string[] = [];
    const requestedPaths: string[] = [];
    const refShas = ["commit-a", "commit-b", "commit-b", "commit-b"];
    const treeEntries = [
      { path: "README.md", mode: "100644", type: "blob", sha: "readme", size: 20 },
      { path: "docs/guide.md", mode: "100644", type: "blob", sha: "docs", size: 20 },
      { path: "package.json", mode: "100644", type: "blob", sha: "manifest", size: 20 },
      { path: ".github/workflows/verify.yml", mode: "100644", type: "blob", sha: "workflow", size: 20 },
      { path: "deploy/k8s.yaml", mode: "100644", type: "blob", sha: "deploy", size: 20 }
    ];
    const commits = Array.from({ length: 100 }, (_, index) => ({
      sha: `recent-${String(index + 1).padStart(3, "0")}`,
      commit: { message: `Synthetic commit ${index + 1}` }
    }));
    const closed = Array.from({ length: 20 }, (_, index) => ({
      id: 9000 + index,
      number: 100 + index,
      title: `Closed work item ${index + 1}`,
      state: "closed",
      updated_at: `2026-08-${String(28 - index).padStart(2, "0")}T00:00:00Z`
    }));

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      methods.push(method);
      requestedPaths.push(`${url.pathname}${url.search}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`
      );

      if (url.pathname === "/user/repos") {
        return jsonResponse([
          {
            id: 1001,
            name: "source-01",
            full_name: "synthetic-owner/source-01",
            owner: { login: "synthetic-owner" },
            private: false,
            visibility: "public",
            default_branch: "main",
            archived: false,
            fork: false,
            updated_at: "2026-08-28T00:00:00Z"
          }
        ]);
      }
      if (url.pathname === "/repos/synthetic-owner/source-01") {
        return jsonResponse({
          id: 1001,
          name: "source-01",
          full_name: "synthetic-owner/source-01",
          owner: { login: "synthetic-owner" },
          private: false,
          visibility: "public",
          default_branch: "main",
          archived: false,
          fork: false,
          updated_at: "2026-08-28T00:00:00Z",
          topics: ["synthetic", "portfolio"],
          license: { spdx_id: "MIT", name: "MIT License" }
        });
      }
      if (url.pathname.endsWith("/git/ref/heads/main")) {
        const sha = refShas.shift();
        if (sha === undefined) {
          throw new Error("Unexpected extra ref request.");
        }
        return jsonResponse({ ref: "refs/heads/main", object: { type: "commit", sha } });
      }
      if (url.pathname.endsWith("/git/commits/commit-a")) {
        return jsonResponse({ sha: "commit-a", tree: { sha: "tree-a" } });
      }
      if (url.pathname.endsWith("/git/commits/commit-b")) {
        return jsonResponse({ sha: "commit-b", tree: { sha: "tree-b" } });
      }
      if (url.pathname.includes("/git/trees/")) {
        const sha = url.pathname.endsWith("tree-a") ? "tree-a" : "tree-b";
        return jsonResponse({ sha, truncated: false, tree: treeEntries });
      }
      if (url.pathname.endsWith("/readme")) {
        return jsonResponse(encodedFile("README.md", "# Synthetic source\n"));
      }
      if (url.pathname.includes("/contents/")) {
        const path = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
        return jsonResponse(encodedFile(path, `Synthetic content for ${path}\n`));
      }
      if (url.pathname.endsWith("/releases")) {
        return jsonResponse([{ id: 1, tag_name: "v1.0.0", draft: false, prerelease: false }]);
      }
      if (url.pathname.endsWith("/languages")) {
        return jsonResponse({ TypeScript: 1200, Python: 300 });
      }
      if (url.pathname.endsWith("/topics")) {
        return jsonResponse({ names: ["synthetic", "portfolio"] });
      }
      if (url.pathname.endsWith("/license")) {
        return jsonResponse({ license: { spdx_id: "MIT", name: "MIT License" } });
      }
      if (url.pathname.endsWith("/commits")) {
        return jsonResponse(commits);
      }
      if (url.pathname.endsWith("/issues") && url.searchParams.get("state") === "open") {
        return jsonResponse([
          { id: 10, number: 1, title: "Open issue", state: "open", updated_at: "2026-08-28T00:00:00Z" },
          { id: 11, number: 2, title: "PR shadow", state: "open", updated_at: "2026-08-28T00:00:00Z", pull_request: {} }
        ]);
      }
      if (url.pathname.endsWith("/pulls") && url.searchParams.get("state") === "open") {
        return jsonResponse([
          { id: 11, number: 2, title: "Open pull request", state: "open", updated_at: "2026-08-28T00:00:00Z", head: { sha: "pr-head" }, base: { sha: "commit-b" } }
        ]);
      }
      if (url.pathname.endsWith("/issues") && url.searchParams.get("state") === "closed") {
        return jsonResponse(closed);
      }
      if (url.pathname.endsWith("/issues/1/comments")) {
        return jsonResponse([{ id: 201, body: "Issue comment" }]);
      }
      if (url.pathname.endsWith("/issues/2/comments")) {
        return jsonResponse([{ id: 202, body: "PR conversation comment" }]);
      }
      if (url.pathname.endsWith("/pulls/2/reviews")) {
        return jsonResponse([{ id: 301, state: "APPROVED", body: "Review" }]);
      }
      if (url.pathname.endsWith("/pulls/2/comments")) {
        return jsonResponse([{ id: 401, body: "Review comment" }]);
      }
      if (/\/issues\/\d+\/comments$/u.test(url.pathname)) {
        return jsonResponse([]);
      }
      if (/\/pulls\/\d+\/(reviews|comments)$/u.test(url.pathname)) {
        return jsonResponse([]);
      }
      throw new Error(`Unhandled synthetic route: ${url.pathname}${url.search}`);
    };

    const checkpoints: unknown[] = [];
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      credentials: { getToken: async () => credential },
      fetch
    });
    const ingestor = new GitHubPortfolioIngestor({
      client,
      now: () => new Date("2026-08-28T12:00:00.000Z")
    });

    const result = await ingestor.ingestOwnedPortfolio({
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      }
    });

    expect(result.repositories).toHaveLength(1);
    const repository = result.repositories[0];
    expect(repository?.status).toBe("complete");
    expect(repository?.attempts).toBe(2);
    expect(repository?.beforeRef?.commitSha).toBe("commit-b");
    expect(repository?.afterRef?.commitSha).toBe("commit-b");
    expect(repository?.files.map((file) => file.kind).sort()).toEqual([
      "deployment",
      "documentation",
      "manifest",
      "readme",
      "workflow"
    ]);
    expect(repository?.releases).toHaveLength(1);
    expect(repository?.languages).toEqual({ TypeScript: 1200, Python: 300 });
    expect(repository?.topics).toEqual(["synthetic", "portfolio"]);
    expect(repository?.license?.spdxId).toBe("MIT");
    expect(repository?.recentCommits).toHaveLength(100);
    expect(repository?.openIssues).toHaveLength(1);
    expect(repository?.openIssues[0]?.comments).toHaveLength(1);
    expect(repository?.openPullRequests).toHaveLength(1);
    expect(repository?.openPullRequests[0]?.comments).toHaveLength(1);
    expect(repository?.openPullRequests[0]?.reviews).toHaveLength(1);
    expect(repository?.openPullRequests[0]?.reviewComments).toHaveLength(1);
    expect(repository?.recentlyClosedWorkItems).toHaveLength(20);
    expect(result.warnings).toContain("synthetic-owner/source-01 moved during ingestion; retried once.");
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(methods.every((method) => method === "GET" || method === "HEAD")).toBe(true);
    expect(requestedPaths.some((path) => path.includes("/releases"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(checkpoints)).not.toContain(credential);
  });

  it("resumes after completed repositories without requesting them again", async () => {
    const requested: string[] = [];
    const client = new GitHubRestClient({
      baseUrl: "https://api.github.test/",
      fetch: async (input) => {
        requested.push(String(input));
        return jsonResponse({ message: "not found" }, { status: 404 });
      }
    });
    const ingestor = new GitHubPortfolioIngestor({ client });
    const completed = {
      requestedFullName: "synthetic-owner/source-01",
      fullName: "synthetic-owner/source-01",
      status: "deleted" as const,
      attempts: 1 as const,
      files: [],
      releases: [],
      languages: {},
      topics: [],
      recentCommits: [],
      openIssues: [],
      openPullRequests: [],
      recentlyClosedWorkItems: [],
      gaps: []
    };

    const result = await ingestor.ingestOwnedPortfolio({
      checkpoint: {
        schemaVersion: "portfolio-ingestion-checkpoint/v1",
        inventory: [
          {
            id: 1001,
            owner: "synthetic-owner",
            name: "source-01",
            fullName: "synthetic-owner/source-01",
            visibility: "public",
            defaultBranch: "main",
            archived: false,
            fork: false,
            updatedAt: "2026-08-28T00:00:00Z"
          }
        ],
        inventoryComplete: true,
        inventoryGaps: [],
        nextRepositoryIndex: 1,
        repositories: [completed]
      }
    });

    expect(requested).toEqual([]);
    expect(result.repositories).toEqual([completed]);
  });

  it("keeps the deterministic fixture inventory synthetic and exactly 23 repositories", async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../../sources/fixtures/portfolio/repositories.synthetic.json",
        import.meta.url
      )
    );
    const repositories = JSON.parse(await readFile(fixturePath, "utf8")) as Array<{
      fullName: string;
      scenario: string;
    }>;

    expect(repositories).toHaveLength(23);
    expect(new Set(repositories.map((repository) => repository.fullName)).size).toBe(23);
    expect(repositories.every((repository) => repository.fullName.startsWith("synthetic-owner/source-"))).toBe(true);
    expect(repositories.map((repository) => repository.scenario)).toEqual(
      expect.arrayContaining(["renamed", "deleted", "permission-gap", "incomplete"])
    );
  });
});
