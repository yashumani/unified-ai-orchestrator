import type { RuntimeServiceState } from "@unified-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProcessLauncher } from "./process-launcher.js";
import { RuntimeManager } from "./runtime-manager.js";

function state(
  service: "ollama" | "whiteshadow",
  phase: RuntimeServiceState["phase"]
): RuntimeServiceState {
  return {
    service,
    phase,
    endpoint:
      service === "ollama" ? "http://127.0.0.1:11434/" : "http://127.0.0.1:8787/",
    checkedAt: "2026-08-28T05:00:00.000Z",
    detail: `${service} is ${phase}`
  };
}

function launchRequest(command: string) {
  return { command, args: ["serve"], cwd: "C:\\runtime" };
}

describe("RuntimeManager", () => {
  it("does not launch services during a status probe", async () => {
    const launcher: ProcessLauncher = { launch: vi.fn() };
    const manager = new RuntimeManager({
      ollama: {
        status: async () => state("ollama", "offline"),
        hasModel: async () => true
      },
      whiteshadow: { status: async () => state("whiteshadow", "offline") },
      ollamaLaunch: launchRequest("C:\\ollama.exe"),
      whiteshadowLaunch: launchRequest("C:\\python.exe"),
      launcher
    });
    await expect(manager.status()).resolves.toMatchObject({
      ollama: { phase: "offline" },
      whiteshadow: { phase: "offline" }
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("collapses concurrent explicit starts", async () => {
    let ollamaChecks = 0;
    let whiteShadowChecks = 0;
    const launcher: ProcessLauncher = {
      launch: vi.fn(async (request) => ({
        pid: request.command.includes("ollama") ? 10 : 11,
        command: request.command,
        startedAt: "2026-08-28T05:00:00.000Z"
      }))
    };
    const manager = new RuntimeManager({
      ollama: {
        status: async () => state("ollama", ollamaChecks++ < 1 ? "offline" : "ready"),
        hasModel: async () => true
      },
      whiteshadow: {
        status: async () =>
          state("whiteshadow", whiteShadowChecks++ < 1 ? "offline" : "ready")
      },
      ollamaLaunch: launchRequest("C:\\ollama.exe"),
      whiteshadowLaunch: launchRequest("C:\\python.exe"),
      launcher,
      readinessTimeoutMs: 1_000,
      pollIntervalMs: 50,
      wait: async () => undefined
    });

    const [first, second] = await Promise.all([manager.start(), manager.start()]);
    expect(first).toEqual(second);
    expect(first.ollama.phase).toBe("ready");
    expect(first.whiteshadow.phase).toBe("ready");
    expect(launcher.launch).toHaveBeenCalledTimes(2);
  });

  it("blocks a ready Ollama service when the pinned model is missing", async () => {
    const manager = new RuntimeManager({
      ollama: {
        status: async () => state("ollama", "ready"),
        hasModel: async () => false
      },
      whiteshadow: { status: async () => state("whiteshadow", "ready") },
      ollamaLaunch: launchRequest("C:\\ollama.exe"),
      whiteshadowLaunch: launchRequest("C:\\python.exe")
    });
    await expect(manager.status()).resolves.toMatchObject({
      ollama: { phase: "blocked", detail: expect.stringContaining("automatic downloads are disabled") }
    });
  });

  it("does not launch a service that already answered in a degraded state", async () => {
    const launcher: ProcessLauncher = { launch: vi.fn() };
    const manager = new RuntimeManager({
      ollama: {
        status: async () => state("ollama", "degraded"),
        hasModel: async () => true
      },
      whiteshadow: { status: async () => state("whiteshadow", "degraded") },
      ollamaLaunch: launchRequest("C:\\ollama.exe"),
      whiteshadowLaunch: launchRequest("C:\\python.exe"),
      launcher
    });
    await expect(manager.start()).resolves.toMatchObject({
      ollama: { phase: "degraded" },
      whiteshadow: { phase: "degraded" }
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });
});
