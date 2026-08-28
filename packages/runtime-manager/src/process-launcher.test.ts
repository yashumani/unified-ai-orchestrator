import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DetachedProcessLauncher } from "./process-launcher.js";

describe("DetachedProcessLauncher", () => {
  it("uses a hidden detached no-shell process with only the supplied environment", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 4321 });
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const launcher = new DetachedProcessLauncher({
      spawn,
      realpath: async (path) => path,
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });

    await expect(
      launcher.launch({
        command: "C:\\runtime\\engine.exe",
        args: ["serve", "--host", "127.0.0.1"],
        cwd: "C:\\runtime",
        env: { SAFE_RUNTIME_VALUE: "present" }
      })
    ).resolves.toEqual({
      pid: 4321,
      command: "C:\\runtime\\engine.exe",
      startedAt: "2026-08-28T05:00:00.000Z"
    });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\runtime\\engine.exe",
      ["serve", "--host", "127.0.0.1"],
      {
        cwd: "C:\\runtime",
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: "ignore",
        env: { SAFE_RUNTIME_VALUE: "present" }
      }
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects relative executable and working-directory paths before spawning", async () => {
    const spawn = vi.fn();
    const launcher = new DetachedProcessLauncher({ spawn });

    await expect(
      launcher.launch({ command: "engine.exe", args: [], cwd: "relative" })
    ).rejects.toThrow(/absolute/u);
    expect(spawn).not.toHaveBeenCalled();
  });
});
