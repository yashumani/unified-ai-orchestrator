import type { RuntimeServiceState } from "@unified-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteShadowCapabilityFeed } from "../api";
import { render } from "../test/render";
import { CapabilityPanel } from "./CapabilityPanel";

function status(phase: RuntimeServiceState["phase"]): RuntimeServiceState {
  return {
    service: "whiteshadow",
    phase,
    endpoint: "http://127.0.0.1:8787/",
    checkedAt: "2026-08-28T12:00:00.000Z",
    detail:
      phase === "ready"
        ? "WhiteShadow model-free read adapter is ready."
        : "WhiteShadow is offline."
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("CapabilityPanel", () => {
  it("does not advertise the static allowlist while WhiteShadow is offline", async () => {
    const feed: WhiteShadowCapabilityFeed = {
      available: false,
      status: status("offline"),
      capabilities: []
    };
    const view = await render(
      <CapabilityPanel
        resource={{ data: feed, loading: false, error: null }}
        onRetry={vi.fn()}
      />
    );

    expect(view.container.textContent).toContain("Capability enrichment unavailable");
    expect(view.container.textContent).toContain("WhiteShadow is offline.");
    expect(view.container.textContent).not.toContain("Runtime summary");
    await view.unmount();
  });

  it("renders safe capabilities after the adapter reports ready", async () => {
    const feed: WhiteShadowCapabilityFeed = {
      available: true,
      status: status("ready"),
      capabilities: [
        {
          capabilityId: "runtime-summary",
          name: "Runtime summary",
          description: "Read a redacted WhiteShadow runtime summary.",
          risk: "safe",
          modelUse: "none",
          mode: "read"
        }
      ]
    };
    const view = await render(
      <CapabilityPanel
        resource={{ data: feed, loading: false, error: null }}
        onRetry={vi.fn()}
      />
    );

    expect(view.container.textContent).toContain("Runtime summary");
    expect(view.container.textContent).toContain("safe · read only");
    expect(view.container.textContent).not.toContain("Capability enrichment unavailable");
    await view.unmount();
  });
});
