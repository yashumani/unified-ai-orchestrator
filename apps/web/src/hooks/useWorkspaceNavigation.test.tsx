import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { WorkspaceNavigation } from "../components/WorkspaceNavigation";
import { render } from "../test/render";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";

vi.mock("../components/ChatSurface", () => ({
  ChatSurface: () => <section aria-label="Governed chat test boundary" />
}));

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKit: ({ children }: { children: ReactNode }) => <>{children}</>
}));

function NavigationHarness() {
  const navigation = useWorkspaceNavigation();

  return (
    <>
      <output data-active-workspace>{navigation.activeWorkspace}</output>
      <WorkspaceNavigation
        activeWorkspace={navigation.activeWorkspace}
        onNavigate={navigation.navigate}
      />
    </>
  );
}

function GuardedNavigationHarness({
  canNavigate
}: {
  canNavigate: (workspace: "operator" | "portfolio" | "dashboard-builder") => boolean;
}) {
  const navigation = useWorkspaceNavigation(canNavigate);
  return (
    <>
      <output data-active-workspace>{navigation.activeWorkspace}</output>
      <WorkspaceNavigation
        activeWorkspace={navigation.activeWorkspace}
        onNavigate={navigation.navigate}
      />
    </>
  );
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function settleWorkspace() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("workspace navigation", () => {
  it("defaults invalid query values to Operator and exposes current-page links", async () => {
    window.history.replaceState({}, "", "/?workspace=unknown");
    const view = await render(<NavigationHarness />);

    expect(
      view.container.querySelector("[data-active-workspace]")?.textContent
    ).toBe("operator");
    const links = Array.from(view.container.querySelectorAll("nav a"));
    expect(links.map((link) => link.textContent)).toEqual([
      "OperatorRuntime, trust, and governed chat",
      "PortfolioRepository evidence and decisions",
      "Dashboard builderManifest authoring and preview"
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links[1]?.hasAttribute("aria-current")).toBe(false);
    expect(links[2]?.getAttribute("href")).toBe(
      "/?workspace=dashboard-builder"
    );

    await view.unmount();
  });

  it("updates the query, clears stale fragments, and follows popstate", async () => {
    window.history.replaceState(
      {},
      "",
      "/console?view=compact&workspace=operator#operator-chat"
    );
    const view = await render(<NavigationHarness />);
    const portfolioLink = Array.from(
      view.container.querySelectorAll<HTMLAnchorElement>("nav a")
    ).find((link) => link.textContent?.startsWith("Portfolio"));

    await act(async () => {
      portfolioLink?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(window.location.pathname).toBe("/console");
    expect(new URLSearchParams(window.location.search).get("view")).toBe(
      "compact"
    );
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "portfolio"
    );
    expect(window.location.hash).toBe("");
    expect(
      view.container.querySelector("[data-active-workspace]")?.textContent
    ).toBe("portfolio");

    await act(async () => {
      window.history.pushState({}, "", "/console?workspace=dashboard-builder");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(
      view.container.querySelector("[data-active-workspace]")?.textContent
    ).toBe("dashboard-builder");
    expect(
      Array.from(view.container.querySelectorAll("nav a"))[2]?.getAttribute(
        "aria-current"
      )
    ).toBe("page");

    await view.unmount();
  });

  it("keeps the current workspace and URL when a dirty-navigation guard blocks links or history", async () => {
    window.history.replaceState({}, "", "/?workspace=operator");
    const canNavigate = vi.fn(() => false);
    const view = await render(
      <GuardedNavigationHarness canNavigate={canNavigate} />
    );
    const portfolioLink = Array.from(
      view.container.querySelectorAll<HTMLAnchorElement>("nav a")
    ).find((link) => link.textContent?.startsWith("Portfolio"));

    await act(async () => {
      portfolioLink?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(window.location.search).toBe("?workspace=operator");
    expect(view.container.querySelector("[data-active-workspace]")?.textContent).toBe(
      "operator"
    );

    await act(async () => {
      window.history.pushState({}, "", "/?workspace=dashboard-builder");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(window.location.search).toBe("?workspace=operator");
    expect(view.container.querySelector("[data-active-workspace]")?.textContent).toBe(
      "operator"
    );
    expect(canNavigate).toHaveBeenCalledWith("portfolio");
    expect(canNavigate).toHaveBeenCalledWith("dashboard-builder");
    await view.unmount();
  });

  it("mounts only the selected Dashboard builder workspace", async () => {
    window.history.replaceState({}, "", "/?workspace=dashboard-builder");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/dashboard-builder/templates") {
        return response({ items: [] });
      }
      if (path === "/api/dashboard-builder/adapters") {
        return response({
          items: [
            {
              adapterId: "fixture",
              label: "Synthetic fixture",
              status: "ready",
              capabilities: {
                portableCalculations: true,
                qlikCalculations: false,
                selections: true,
                paging: true
              },
              diagnostics: []
            },
            {
              adapterId: "qlik",
              label: "Qlik",
              status: "unavailable",
              capabilities: {
                portableCalculations: false,
                qlikCalculations: false,
                selections: false,
                paging: false
              },
              diagnostics: []
            }
          ]
        });
      }
      throw new Error(`Unexpected active-workspace request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await render(<App />);
    await settleWorkspace();

    expect(view.container.querySelector("#workspace-main")).not.toBeNull();
    expect(
      view.container.querySelector<HTMLAnchorElement>("a.skip-link")?.hash
    ).toBe("#workspace-main");
    expect(view.container.textContent).toContain("Dashboard builder");
    expect(view.container.textContent).not.toContain("Unified operator console");
    expect(view.container.textContent).not.toContain("Portfolio Overview");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/dashboard-builder/templates",
      "/api/dashboard-builder/adapters"
    ]);

    await view.unmount();
  });

  it("mounts Operator without starting hidden portfolio polling", async () => {
    window.history.replaceState({}, "", "/?workspace=operator");
    const checkedAt = "2026-08-29T12:00:00.000Z";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/runtime/status") {
        return response({
          model: "qwen3:4b",
          ollama: {
            service: "ollama",
            phase: "ready",
            endpoint: "http://127.0.0.1:11434",
            checkedAt,
            detail: "The pinned model is available.",
            model: "qwen3:4b"
          },
          whiteshadow: {
            service: "whiteshadow",
            phase: "ready",
            endpoint: "http://127.0.0.1:8787",
            checkedAt,
            detail: "The read-only adapter is ready."
          }
        });
      }
      if (path === "/api/trust") {
        return response({
          trusted: false,
          identity: {
            repositoryRoot: "D:\\workspace",
            origin: "https://example.invalid/repository.git",
            originSha256: "a".repeat(64),
            branch: "feature/dashboard-builder",
            protectedBranch: false
          },
          grant: null,
          reason: "No active persistent workspace grant exists."
        });
      }
      if (path === "/api/repository/status") {
        return response({
          branch: "feature/dashboard-builder",
          clean: true,
          stagedCount: 0,
          unstagedCount: 0,
          conflictCount: 0,
          entries: [],
          protectedEntriesOmitted: false,
          untrackedEntriesOmitted: false,
          truncated: false
        });
      }
      if (path === "/api/runs?limit=12") {
        return response({ runs: [] });
      }
      if (path === "/api/whiteshadow/capabilities") {
        return response({
          available: false,
          status: {
            service: "whiteshadow",
            phase: "offline",
            endpoint: "http://127.0.0.1:8787",
            checkedAt,
            detail: "WhiteShadow is offline."
          },
          capabilities: []
        });
      }
      throw new Error(`unexpected hidden-workspace request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await render(<App />);
    await settleWorkspace();

    expect(view.container.textContent).toContain("Unified operator console");
    expect(view.container.textContent).toContain("Local request path");
    expect(view.container.textContent).not.toContain("Portfolio Overview");
    expect(
      fetchMock.mock.calls.every(
        ([path]) => !String(path).startsWith("/api/portfolio/")
      )
    ).toBe(true);

    await view.unmount();
  });

  it("mounts Portfolio without starting hidden operator polling", async () => {
    window.history.replaceState({}, "", "/?workspace=portfolio");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/portfolio/")) {
        return response({ items: [] });
      }
      throw new Error(`unexpected hidden-workspace request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await render(<App />);
    await settleWorkspace();

    expect(view.container.textContent).toContain("Portfolio Overview");
    expect(view.container.textContent).not.toContain("Unified operator console");
    expect(view.container.textContent).not.toContain(
      "Dashboard builder workspace"
    );
    expect(
      fetchMock.mock.calls.every(([path]) =>
        String(path).startsWith("/api/portfolio/")
      )
    ).toBe(true);

    await view.unmount();
  });
});
