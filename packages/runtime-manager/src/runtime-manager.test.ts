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

  it("reports starting only while an explicit launch is actually in progress", async () => {
    let phase: RuntimeServiceState["phase"] = "offline";
    let releaseLaunch: (() => void) | undefined;
    let launchStartedResolve: (() => void) | undefined;
    const launchStarted = new Promise<void>((resolve) => {
      launchStartedResolve = resolve;
    });
    const launchReleased = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const launcher: ProcessLauncher = {
      launch: vi.fn(async (request) => {
        launchStartedResolve?.();
        await launchReleased;
        return {
          pid: 12,
          command: request.command,
          startedAt: "2026-08-28T05:00:00.000Z"
        };
      })
    };
    const manager = new RuntimeManager({
      ollama: {
        status: async () => state("ollama", phase),
        hasModel: async () => true
      },
      whiteshadow: { status: async () => state("whiteshadow", phase) },
      ollamaLaunch: launchRequest("C:\\ollama.exe"),
      whiteshadowLaunch: launchRequest("C:\\python.exe"),
      launcher,
      readinessTimeoutMs: 1_000,
      pollIntervalMs: 50,
      wait: async () => undefined
    });

    const start = manager.start();
    await launchStarted;
    await expect(manager.status()).resolves.toMatchObject({
      ollama: { phase: "starting" },
      whiteshadow: { phase: "starting" }
    });

    phase = "ready";
    releaseLaunch?.();
    await expect(start).resolves.toMatchObject({
      ollama: { phase: "ready" },
      whiteshadow: { phase: "ready" }
    });
    await expect(manager.status()).resolves.toMatchObject({
      ollama: { phase: "ready" },
      whiteshadow: { phase: "ready" }
    });
  });

  it("does not label a failed service as starting while its peer still launches", async () => {
    let releaseWhiteShadow: (() => void) | undefined;
    let whiteShadowStartedResolve: (() => void) | undefined;
    const whiteShadowStarted = new Promise<void>((resolve) => {
      whiteShadowStartedResolve = resolve;
    });
    const whiteShadowReleased = new Promise<void>((resolve) => {
      releaseWhiteShadow = resolve;
    });
    let whiteShadowReady = false;
    const launcher: ProcessLauncher = {
      launch: vi.fn(async (request) => {
        if (request.command.includes("ollama")) {
          throw new Error("launch denied");
        }
        whiteShadowStartedResolve?.();
        await whiteShadowReleased;
        whiteShadowReady = true;
        return {
          pid: 13,
          command: request.command,
          startedAt: "2026-08-28T05:00:00.000Z"
        };
      })
    };
    const manager = new RuntimeManager({
      ollama: {
        status: async () => state("ollama", "offline"),
        hasModel: async () => true
      },
      whiteshadow: {
        status: async () =>
          state("whiteshadow", whiteShadowReady ? "ready" : "offline")
      },
      ollamaLaunch: launchRequest("C:\\ollama.exe"),
      whiteshadowLaunch: launchRequest("C:\\python.exe"),
      launcher,
      readinessTimeoutMs: 1_000,
      pollIntervalMs: 50,
      wait: async () => undefined
    });

    const start = manager.start();
    await whiteShadowStarted;
    await expect(manager.status()).resolves.toMatchObject({
      ollama: { phase: "blocked", detail: expect.stringContaining("launch denied") },
      whiteshadow: { phase: "starting" }
    });
    releaseWhiteShadow?.();
    await expect(start).resolves.toMatchObject({
      ollama: { phase: "blocked" },
      whiteshadow: { phase: "ready" }
    });
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
