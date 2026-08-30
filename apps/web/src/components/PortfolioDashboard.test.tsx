import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PortfolioCluster,
  PortfolioRecommendation,
  PortfolioRepository,
  PortfolioRun
} from "../portfolio-types";
import { render } from "../test/render";
import { PortfolioDashboard } from "./PortfolioDashboard";

const RUN: PortfolioRun = {
  runId: "portfolio-run-1",
  status: "succeeded",
  createdAt: "2026-08-29T12:00:00.000Z",
  completedAt: "2026-08-29T12:04:00.000Z",
  repositoryCount: 23,
  completeCount: 22,
  incompleteCount: 1,
  warningCount: 1,
  revisionMismatchCount: 0,
  warnings: ["One private repository has a permission gap."]
};

const REPOSITORY: PortfolioRepository = {
  repositoryId: "repository-101",
  fullName: "example/knowledge-console",
  visibility: "private",
  purpose: "Turns cited repository evidence into a governed operator view.",
  capabilities: ["evidence retrieval", "local orchestration"],
  technologyTags: ["TypeScript", "React"],
  evidenceCoverage: 0.88,
  chatCoverage: 0.4,
  contradictions: ["Chat intent says cloud-first; manifests remain local-only."],
  citations: [
    {
      citationId: "citation-1",
      family: "documentation",
      locator: "README.md#purpose",
      statement: "README purpose statement"
    }
  ],
  capturedRevision: "a".repeat(40),
  recommendationAction: "adopt-capability-into-orchestrator"
};

const CLUSTER: PortfolioCluster = {
  clusterId: "cluster-1",
  label: "Cited knowledge surfaces",
  rationale: "These repositories share evidence retrieval and operator review.",
  sharedCapabilities: ["evidence retrieval"],
  repositoryIds: ["repository-101", "repository-102"],
  citationIds: ["citation-1"]
};

const RECOMMENDATION: PortfolioRecommendation = {
  recommendationId: "recommendation-1",
  repositoryIds: ["repository-101"],
  action: "adopt-capability-into-orchestrator",
  lifecycle: "draft",
  rationale: "Adopt the cited evidence viewer without merging deployment ownership.",
  confidence: {
    coverage: 0.9,
    citations: 1,
    classifierAgreement: 0.5,
    ruleSupport: 1,
    weightedConfidence: 0.865
  },
  eligibleActions: [
    "keep-standalone",
    "adopt-capability-into-orchestrator",
    "defer-insufficient-evidence"
  ],
  citationIds: ["citation-1"],
  contradictions: ["Deployment ownership is not yet cited."]
};

function apiResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body
  } satisfies Pick<Response, "ok" | "status" | "json">;
}

function fixtureFetch(options: {
  runs?: PortfolioRun[];
  repositories?: PortfolioRepository[];
  clusters?: PortfolioCluster[];
  recommendations?: PortfolioRecommendation[];
  failure?: { path: string; message: string };
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (options.failure?.path === path) {
      return apiResponse(
        { error: { code: "evidence_integrity", message: options.failure.message } },
        false,
        409
      );
    }
    if (init?.method === "POST" && path.endsWith("/override")) {
      return apiResponse({
        ...RECOMMENDATION,
        action: "keep-standalone",
        lifecycle: "overridden"
      });
    }
    if (init?.method === "POST" && path === "/api/portfolio/chat-imports") {
      return apiResponse({ importedCount: 2, receiptId: "import-receipt" });
    }
    if (init?.method === "POST" && path === "/api/portfolio/runs") {
      return apiResponse({ runId: "portfolio-run-2", status: "queued" });
    }
    if (path === "/api/portfolio/runs") {
      return apiResponse({ items: options.runs ?? [RUN] });
    }
    if (path === "/api/portfolio/repositories") {
      return apiResponse({ items: options.repositories ?? [REPOSITORY] });
    }
    if (path === "/api/portfolio/clusters") {
      return apiResponse({ items: options.clusters ?? [CLUSTER] });
    }
    if (path === "/api/portfolio/recommendations") {
      return apiResponse({ items: options.recommendations ?? [RECOMMENDATION] });
    }
    throw new Error(`unexpected path ${path}`);
  });
}

async function settlePortfolio() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function enterValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("PortfolioDashboard", () => {
  it("keeps a truthful loading state while portfolio evidence is in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const view = await render(<PortfolioDashboard />);

    expect(view.container.textContent).toContain("Loading portfolio evidence");
    await view.unmount();
  });

  it("renders overview, profiles, overlaps, recommendations, evidence, and run history", async () => {
    vi.stubGlobal("fetch", fixtureFetch());
    const view = await render(<PortfolioDashboard />);
    await settlePortfolio();

    const text = view.container.textContent ?? "";
    expect(text).toContain("Portfolio Overview");
    expect(text).toContain("23 repositories");
    expect(text).toContain("Repository profiles");
    expect(text).toContain("example/knowledge-console");
    expect(text).toContain("Cited knowledge surfaces");
    expect(text).toContain("Recommendations");
    expect(text).toContain("Evidence & contradictions");
    expect(text).toContain("README purpose statement");
    expect(text).toContain("Run history");
    expect(text).toContain("Incomplete evidence");
    expect(text).toContain("Degraded enrichment");
    await view.unmount();
  });

  it("gives an actionable empty state", async () => {
    vi.stubGlobal(
      "fetch",
      fixtureFetch({ runs: [], repositories: [], clusters: [], recommendations: [] })
    );
    const view = await render(<PortfolioDashboard />);
    await settlePortfolio();

    expect(view.container.textContent).toContain("No portfolio run yet");
    expect(view.container.textContent).toContain("Start portfolio run");
    await view.unmount();
  });

  it("distinguishes integrity failures from ordinary degraded data", async () => {
    vi.stubGlobal(
      "fetch",
      fixtureFetch({
        failure: {
          path: "/api/portfolio/recommendations",
          message: "Stored recommendation failed its SHA-256 integrity check."
        }
      })
    );
    const view = await render(<PortfolioDashboard />);
    await settlePortfolio();

    const integrityAlert = view.container.querySelector(
      '[data-portfolio-state="integrity"]'
    );
    expect(integrityAlert?.textContent).toContain("Integrity check failed");
    expect(integrityAlert?.textContent).toContain("SHA-256 integrity check");
    await view.unmount();
  });

  it("imports ChatGPT JSON and records an explicit recommendation override", async () => {
    const fetchMock = fixtureFetch();
    vi.stubGlobal("fetch", fetchMock);
    const view = await render(<PortfolioDashboard />);
    await settlePortfolio();

    const projectInput = view.container.querySelector<HTMLInputElement>(
      'input[name="projectId"]'
    );
    const jsonInput = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[name="conversations"]'
    );
    expect(projectInput).not.toBeNull();
    expect(jsonInput).not.toBeNull();
    await act(async () => {
      if (projectInput !== null) {
        enterValue(projectInput, "app-development");
      }
      if (jsonInput !== null) {
        enterValue(
          jsonInput,
          JSON.stringify([{ id: "chat-1" }, { id: "chat-2" }])
        );
      }
    });
    const importButton = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Import ChatGPT JSON"
    );
    await act(async () => {
      importButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("Imported 2 conversations");

    const overrideForm = view.container.querySelector<HTMLFormElement>(
      '[data-override-for="recommendation-1"]'
    );
    expect(overrideForm).not.toBeNull();
    await act(async () => {
      overrideForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("Override recorded");

    const postBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => init?.body);
    expect(postBodies).toContain(
      JSON.stringify({
        projectId: "app-development",
        conversations: [{ id: "chat-1" }, { id: "chat-2" }]
      })
    );
    expect(postBodies).toContain(
      JSON.stringify({
        action: "keep-standalone",
        reasonCode: "missing-context",
        explanation: "Reviewed against repository evidence.",
        providedBy: "yashu"
      })
    );
    await view.unmount();
  });
});
