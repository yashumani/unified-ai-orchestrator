import type { TrustState } from "@unified-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "../test/render";
import { TrustPanel } from "./TrustPanel";

const UNTRUSTED: TrustState = {
  trusted: false,
  identity: {
    repositoryRoot: "D:\\workspace",
    origin: "https://example.invalid/repository.git",
    originSha256: "a".repeat(64),
    branch: "feature/ollama-orchestration",
    protectedBranch: false
  },
  grant: null,
  reason: "No active persistent workspace grant exists."
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("TrustPanel", () => {
  it("offers permanent trust only for an unprotected branch", async () => {
    const view = await render(
      <TrustPanel
        resource={{ data: UNTRUSTED, loading: false, error: null }}
        pending={null}
        actionError={null}
        actionMessage={null}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    const button = view.container.querySelector("button.primary-button");
    expect(button?.textContent).toBe("Grant permanent trust");
    expect((button as HTMLButtonElement | null)?.disabled).toBe(false);
    expect(view.container.textContent).toContain("feature/ollama-orchestration");
    await view.unmount();
  });

  it("disables trust grants on protected branches", async () => {
    const view = await render(
      <TrustPanel
        resource={{
          data: {
            ...UNTRUSTED,
            identity: { ...UNTRUSTED.identity, branch: "main", protectedBranch: true }
          },
          loading: false,
          error: null
        }}
        pending={null}
        actionError={null}
        actionMessage={null}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(
      (view.container.querySelector("button.primary-button") as HTMLButtonElement | null)
        ?.disabled
    ).toBe(true);
    await view.unmount();
  });
});
