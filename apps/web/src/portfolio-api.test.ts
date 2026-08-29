import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPortfolioClusters,
  getPortfolioRecommendations,
  getPortfolioRepositories,
  getPortfolioRuns,
  importPortfolioChats,
  overridePortfolioRecommendation,
  startPortfolioRun
} from "./portfolio-api";

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } satisfies Pick<Response, "ok" | "status" | "json">;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portfolio API projections", () => {
  it("uses the approved list and refresh endpoints", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/portfolio/runs") {
        return response({ items: [] });
      }
      if (path === "/api/portfolio/repositories") {
        return response({ items: [] });
      }
      if (path === "/api/portfolio/clusters") {
        return response({ items: [] });
      }
      if (path === "/api/portfolio/recommendations") {
        return response({ items: [] });
      }
      throw new Error(`unexpected path ${path}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPortfolioRuns()).resolves.toEqual([]);
    await expect(getPortfolioRepositories()).resolves.toEqual([]);
    await expect(getPortfolioClusters()).resolves.toEqual([]);
    await expect(getPortfolioRecommendations()).resolves.toEqual([]);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/portfolio/runs",
      "/api/portfolio/repositories",
      "/api/portfolio/clusters",
      "/api/portfolio/recommendations"
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
      true
    );
  });

  it("serializes start, override, and ChatGPT import bodies without widening them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ runId: "portfolio-run-2", status: "queued" }))
      .mockResolvedValueOnce(
        response({
          recommendationId: "recommendation-1",
          repositoryIds: ["repository-1"],
          action: "keep-standalone",
          lifecycle: "overridden",
          rationale: "Operator context changed the decision.",
          confidence: {
            coverage: 1,
            citations: 1,
            classifierAgreement: 1,
            ruleSupport: 1,
            weightedConfidence: 1
          },
          eligibleActions: ["keep-standalone"],
          citationIds: ["citation-1"],
          contradictions: []
        })
      )
      .mockResolvedValueOnce(response({ importedCount: 4, receiptId: "receipt-import-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await startPortfolioRun();
    await overridePortfolioRecommendation("recommendation/1", {
      action: "keep-standalone",
      reasonCode: "missing-context",
      explanation: "The products have separate release owners.",
      providedBy: "yashu"
    });
    await importPortfolioChats({
      projectId: "app-development",
      conversations: [{ id: "conversation-1" }]
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/portfolio/runs",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/portfolio/recommendations/recommendation%2F1/override",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "keep-standalone",
          reasonCode: "missing-context",
          explanation: "The products have separate release owners.",
          providedBy: "yashu"
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/portfolio/chat-imports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "app-development",
          conversations: [{ id: "conversation-1" }]
        })
      })
    );
  });
});
