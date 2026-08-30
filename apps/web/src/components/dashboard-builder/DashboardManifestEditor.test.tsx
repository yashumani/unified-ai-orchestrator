import {
  DashboardManifestSchema,
  type DashboardManifest
} from "@unified-ai/contracts/dashboard-builder";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "../../test/render";
import { DashboardManifestEditor } from "./DashboardManifestEditor";

const repositoryRoot = process.cwd().endsWith(`${sep}apps${sep}web`)
  ? resolve(process.cwd(), "..", "..")
  : process.cwd();
let manifest: DashboardManifest;

function enterText(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  if (setter === undefined) throw new Error("textarea value setter missing");
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeAll(async () => {
  manifest = DashboardManifestSchema.parse(
    JSON.parse(
      await readFile(
        resolve(
          repositoryRoot,
          "sources",
          "fixtures",
          "dashboard-builder",
          "sales-overview.manifest.json"
        ),
        "utf8"
      )
    ) as unknown
  );
});

describe("dashboard manifest editor", () => {
  it("preserves an invalid portable-expression buffer and blocks save validity until corrected", async () => {
    const onBufferedChange = vi.fn();
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    const view = await render(
      <DashboardManifestEditor
        manifest={manifest}
        disabled={false}
        onBufferedChange={onBufferedChange}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />
    );
    onValidityChange.mockClear();
    const textarea = view.container.querySelector<HTMLTextAreaElement>(
      ".dashboard-editor-record textarea"
    );
    if (textarea === null) throw new Error("portable expression editor missing");

    await act(async () => {
      enterText(textarea, '{"kind":"operation"');
    });

    expect(textarea.value).toBe('{"kind":"operation"');
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(view.container.textContent).toContain(
      "Enter a valid allowlisted portable expression tree."
    );
    expect(onBufferedChange).toHaveBeenCalledTimes(1);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();

    const validExpression = JSON.stringify({ kind: "literal", value: 7 });
    await act(async () => {
      enterText(textarea, validExpression);
    });

    expect(textarea.getAttribute("aria-invalid")).toBe("false");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        calculations: expect.arrayContaining([
          expect.objectContaining({
            calculationId: "total-sales",
            expression: { kind: "literal", value: 7 }
          })
        ])
      })
    );
    await view.unmount();
  });
});
