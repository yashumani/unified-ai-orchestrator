import {
  PINNED_OLLAMA_MODEL,
  RuntimeServiceStateSchema,
  RuntimeStatusSchema,
  type RuntimeServiceState,
  type RuntimeStatus
} from "@unified-ai/contracts";
import {
  DetachedProcessLauncher,
  type ProcessLaunchRequest,
  type ProcessLauncher
} from "./process-launcher.js";

export interface OllamaRuntimeAdapter {
  status(): Promise<RuntimeServiceState>;
  hasModel(model: typeof PINNED_OLLAMA_MODEL): Promise<boolean>;
}

export interface WhiteShadowRuntimeAdapter {
  status(): Promise<RuntimeServiceState>;
}

export interface RuntimeManagerOptions {
  ollama: OllamaRuntimeAdapter;
  whiteshadow: WhiteShadowRuntimeAdapter;
  ollamaLaunch: ProcessLaunchRequest;
  whiteshadowLaunch: ProcessLaunchRequest;
  launcher?: ProcessLauncher;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function safeState(
  service: "ollama" | "whiteshadow",
  endpoint: string,
  error: unknown
): RuntimeServiceState {
  return RuntimeServiceStateSchema.parse({
    service,
    phase: "offline",
    endpoint,
    checkedAt: now(),
    detail:
      error instanceof Error
        ? `${service} probe failed: ${error.message}`
        : `${service} probe failed.`
  });
}

function transitioned(
  state: RuntimeServiceState,
  phase: RuntimeServiceState["phase"],
  detail: string
): RuntimeServiceState {
  return RuntimeServiceStateSchema.parse({
    ...state,
    phase,
    checkedAt: now(),
    detail
  });
}

export class RuntimeManager {
  readonly #ollama: OllamaRuntimeAdapter;
  readonly #whiteshadow: WhiteShadowRuntimeAdapter;
  readonly #ollamaLaunch: ProcessLaunchRequest;
  readonly #whiteshadowLaunch: ProcessLaunchRequest;
  readonly #launcher: ProcessLauncher;
  readonly #readinessTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #wait: (milliseconds: number) => Promise<void>;
  #startPromise: Promise<RuntimeStatus> | undefined;

  constructor(options: RuntimeManagerOptions) {
    this.#ollama = options.ollama;
    this.#whiteshadow = options.whiteshadow;
    this.#ollamaLaunch = options.ollamaLaunch;
    this.#whiteshadowLaunch = options.whiteshadowLaunch;
    this.#launcher = options.launcher ?? new DetachedProcessLauncher();
    this.#readinessTimeoutMs = Math.max(
      1_000,
      Math.min(options.readinessTimeoutMs ?? 15_000, 60_000)
    );
    this.#pollIntervalMs = Math.max(
      50,
      Math.min(options.pollIntervalMs ?? 250, 2_000)
    );
    this.#wait =
      options.wait ??
      (async (milliseconds) => {
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      });
  }

  async status(): Promise<RuntimeStatus> {
    const [ollama, whiteshadow] = await Promise.all([
      this.#probeOllama(),
      this.#probeWhiteShadow()
    ]);
    return RuntimeStatusSchema.parse({
      model: PINNED_OLLAMA_MODEL,
      ollama,
      whiteshadow
    });
  }

  start(): Promise<RuntimeStatus> {
    this.#startPromise ??= this.#startServices().finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  async #startServices(): Promise<RuntimeStatus> {
    const initial = await this.status();
    const [ollama, whiteshadow] = await Promise.all([
      this.#startOllama(initial.ollama),
      this.#startWhiteShadow(initial.whiteshadow)
    ]);
    return RuntimeStatusSchema.parse({
      model: PINNED_OLLAMA_MODEL,
      ollama,
      whiteshadow
    });
  }

  async #startOllama(initial: RuntimeServiceState): Promise<RuntimeServiceState> {
    if (initial.phase === "starting") {
      return this.#poll(() => this.#probeOllama(), "ollama");
    }
    if (initial.phase !== "offline") {
      return initial;
    }
    try {
      await this.#launcher.launch(this.#ollamaLaunch);
    } catch (error) {
      return transitioned(
        initial,
        "blocked",
        error instanceof Error
          ? `Ollama could not be started: ${error.message}`
          : "Ollama could not be started."
      );
    }

    const ready = await this.#poll(() => this.#probeOllama(), "ollama");
    return ready;
  }

  async #startWhiteShadow(initial: RuntimeServiceState): Promise<RuntimeServiceState> {
    if (initial.phase === "starting") {
      return this.#poll(() => this.#probeWhiteShadow(), "whiteshadow");
    }
    if (initial.phase !== "offline") {
      return initial;
    }
    try {
      await this.#launcher.launch(this.#whiteshadowLaunch);
    } catch (error) {
      return transitioned(
        initial,
        "degraded",
        error instanceof Error
          ? `WhiteShadow could not be started: ${error.message}`
          : "WhiteShadow could not be started."
      );
    }
    const state = await this.#poll(() => this.#probeWhiteShadow(), "whiteshadow");
    return state.phase === "blocked" ? transitioned(state, "degraded", state.detail) : state;
  }

  async #poll(
    probe: () => Promise<RuntimeServiceState>,
    service: "ollama" | "whiteshadow"
  ): Promise<RuntimeServiceState> {
    const deadline = Date.now() + this.#readinessTimeoutMs;
    let latest = await probe();
    while (latest.phase !== "ready" && Date.now() < deadline) {
      await this.#wait(this.#pollIntervalMs);
      latest = await probe();
      if (latest.phase === "blocked") {
        return latest;
      }
    }
    if (latest.phase === "ready") {
      return latest;
    }
    return transitioned(
      latest,
      service === "ollama" ? "blocked" : "degraded",
      `${service} did not become ready within the bounded startup window.`
    );
  }

  async #probeOllama(): Promise<RuntimeServiceState> {
    let state: RuntimeServiceState;
    try {
      state = RuntimeServiceStateSchema.parse(await this.#ollama.status());
    } catch (error) {
      state = safeState("ollama", "http://127.0.0.1:11434/", error);
    }
    if (state.phase !== "ready") {
      return state;
    }
    try {
      if (!(await this.#ollama.hasModel(PINNED_OLLAMA_MODEL))) {
        return transitioned(
          state,
          "blocked",
          `Required local model ${PINNED_OLLAMA_MODEL} is missing; automatic downloads are disabled.`
        );
      }
      return { ...state, model: PINNED_OLLAMA_MODEL };
    } catch (error) {
      return transitioned(
        state,
        "blocked",
        error instanceof Error
          ? `Ollama model inventory failed: ${error.message}`
          : "Ollama model inventory failed."
      );
    }
  }

  async #probeWhiteShadow(): Promise<RuntimeServiceState> {
    try {
      return RuntimeServiceStateSchema.parse(await this.#whiteshadow.status());
    } catch (error) {
      return safeState("whiteshadow", "http://127.0.0.1:8787/", error);
    }
  }
}
