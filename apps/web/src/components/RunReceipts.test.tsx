import type { AgentRunReceipt } from "@unified-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "../test/render";
import { RunReceipts } from "./RunReceipts";

const RECEIPT: AgentRunReceipt = {
  schemaVersion: "1.0.0",
  runId: "run-test",
  threadId: "thread-test",
  messageIds: ["message-test"],
  status: "succeeded",
  model: "qwen3:4b",
  runtime: { contextSize: 4096, temperature: 0.2, thinking: false },
  toolSchemaObjectSha256: "d".repeat(64),
  workspace: {
    repositoryRootSha256: "e".repeat(64),
    originSha256: "f".repeat(64),
    branch: "feature/test"
  },
  startedAt: "2026-08-28T12:00:00.000Z",
  completedAt: "2026-08-28T12:00:03.000Z",
  iterations: 2,
  toolCalls: [
    {
      callId: "call-1",
      toolName: "repository.git_status",
      argumentsObjectSha256: "1".repeat(64),
      policyCode: "allowed",
      policyReason: "Read-only tool.",
      policyCheckedAt: "2026-08-28T12:00:01.000Z",
      outcome: "succeeded",
      resultObjectSha256: "b".repeat(64),
      resultPayloadSha256: "2".repeat(64),
      summary: "Status read."
    }
  ],
  inputObjectSha256: "a".repeat(64),
  outputObjectSha256: "c".repeat(64),
  usage: { available: false },
  warnings: []
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("RunReceipts", () => {
  it("gives an actionable empty state", async () => {
    const view = await render(
      <RunReceipts
        resource={{ data: [], loading: false, error: null }}
        onRetry={vi.fn()}
      />
    );
    expect(view.container.textContent).toContain("Send a chat request");
    await view.unmount();
  });

  it("renders evidence and policy outcomes without prompt content", async () => {
    const view = await render(
      <RunReceipts
        resource={{ data: [RECEIPT], loading: false, error: null }}
        onRetry={vi.fn()}
      />
    );
    expect(view.container.textContent).toContain("run-test");
    expect(view.container.textContent).toContain("repository.git_status");
    expect(view.container.textContent).toContain("allowed");
    expect(view.container.textContent).toContain("succeeded");
    await view.unmount();
  });
});
