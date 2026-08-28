import type { RuntimeStatus as RuntimeStatusType } from "@unified-ai/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "../test/render";
import { RuntimeStatus } from "./RuntimeStatus";

const READY_RUNTIME: RuntimeStatusType = {
  model: "qwen3:4b",
  ollama: {
    service: "ollama",
    phase: "ready",
    endpoint: "http://127.0.0.1:11434",
    checkedAt: "2026-08-28T12:00:00.000Z",
    detail: "The pinned model is available.",
    model: "qwen3:4b"
  },
  whiteshadow: {
    service: "whiteshadow",
    phase: "degraded",
    endpoint: "http://127.0.0.1:8787",
    checkedAt: "2026-08-28T12:00:00.000Z",
    detail: "Capability enrichment is unavailable."
  }
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("RuntimeStatus", () => {
  it("renders truthful mixed runtime phases and the fixed model", async () => {
    const view = await render(
      <RuntimeStatus
        resource={{ data: READY_RUNTIME, loading: false, error: null }}
        starting={false}
        actionError={null}
        actionMessage={null}
        onStart={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(view.container.textContent).toContain("qwen3:4b");
    expect(view.container.textContent).toContain("ready");
    expect(view.container.textContent).toContain("degraded");
    expect(view.container.textContent).toContain("Start local AI");
    await view.unmount();
  });

  it("calls the explicit startup action", async () => {
    const onStart = vi.fn();
    const view = await render(
      <RuntimeStatus
        resource={{ data: READY_RUNTIME, loading: false, error: null }}
        starting={false}
        actionError={null}
        actionMessage={null}
        onStart={onStart}
        onRetry={vi.fn()}
      />
    );
    const startButton = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Start local AI"
    );
    expect(startButton).toBeDefined();
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStart).toHaveBeenCalledOnce();
    await view.unmount();
  });
});
