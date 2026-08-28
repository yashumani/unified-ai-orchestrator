import { afterEach, describe, expect, it } from "vitest";
import { render } from "../test/render";
import { parseToolResult, safeParameterRows, ToolCard } from "./ToolCard";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ToolCard", () => {
  it("shows only allowlisted argument values", () => {
    expect(
      safeParameterRows({
        path: "src/App.tsx",
        token: "must-not-render",
        content: "private file content"
      })
    ).toEqual([
      { key: "path", value: "src/App.tsx" },
      { key: "token", value: "[not displayed]" },
      { key: "content", value: "[not displayed]" }
    ]);
  });

  it("never renders an unstructured raw tool result", async () => {
    expect(parseToolResult("credential-shaped raw output").summary).toBe(
      "The governed server returned a bounded result."
    );

    const view = await render(
      <ToolCard
        name="repository.read_file"
        parameters={{ path: "src/App.tsx", content: "private" }}
        status="complete"
        result="credential-shaped raw output"
      />
    );
    expect(view.container.textContent).toContain("src/App.tsx");
    expect(view.container.textContent).not.toContain("credential-shaped raw output");
    expect(view.container.textContent).not.toContain("private");
    await view.unmount();
  });
});
