import type { PortfolioService } from "@unified-ai/portfolio-reconciliation";
import { describe, expect, it, vi } from "vitest";
import { PortfolioToolRegistry } from "./portfolio-tools.js";

function service(): PortfolioService {
  return {
    listRepositories: vi.fn(() => [
      {
        repositoryId: "repository-fixture",
        fullName: "fixture-owner/fixture-repository",
        visibility: "private",
        purpose: "Synthetic purpose",
        capabilities: ["evidence"],
        technologyTags: ["typescript"],
        evidenceCoverage: 1,
        chatCoverage: 0,
        contradictions: [],
        citations: [
          {
            citationId: "citation-fixture",
            family: "documentation",
            locator: "github:fixture-owner/fixture-repository/documentation",
            statement: "documentation query complete; 1 bounded evidence field recorded."
          }
        ],
        capturedRevision: "a".repeat(40)
      }
    ]),
    getRepository: vi.fn(),
    listClusters: vi.fn(() => []),
    getCluster: vi.fn(),
    listRecommendations: vi.fn(() => [])
  } as unknown as PortfolioService;
}

describe("portfolio model tools", () => {
  it("exposes only the six approved read surfaces", () => {
    const registry = new PortfolioToolRegistry(service());
    const definitions = registry.listDefinitions();
    expect(definitions).toHaveLength(6);
    expect(definitions.every((definition) => definition.mode === "read")).toBe(
      true
    );
    expect(definitions.map((definition) => definition.name).join(" ")).not.toMatch(
      /refresh|override|import/iu
    );
  });

  it("resolves only sanitized citations and performs no mutation", async () => {
    const configuredService = service();
    const registry = new PortfolioToolRegistry(configuredService);
    const result = await registry.execute({
      callId: "portfolio-call-1",
      toolName: "portfolio.resolve_citation",
      arguments: { citationId: "citation-fixture" }
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ citationId: "citation-fixture" });
    expect(configuredService.listRepositories).toHaveBeenCalledOnce();
  });

  it("rejects refresh and override names outside the fixed contract", async () => {
    const registry = new PortfolioToolRegistry(service());
    await expect(
      registry.execute({
        callId: "portfolio-call-2",
        toolName: "portfolio.refresh",
        arguments: {}
      })
    ).resolves.toMatchObject({ ok: false });
  });
});
