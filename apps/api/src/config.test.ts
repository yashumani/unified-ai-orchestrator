import { PINNED_OLLAMA_MODEL } from "@unified-ai/contracts";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_OLLAMA_EXECUTABLE,
  CANONICAL_WHITESHADOW_WORKSPACE,
  readConfig
} from "./config.js";

const repositoryRoot = "D:\\Yashu-AI-Workspace\\unified-ai-orchestrator";

describe("readConfig", () => {
  it("builds a loopback-only configuration pinned to qwen3:4b", () => {
    const config = readConfig(
      {
        ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
        OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
        WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
      },
      repositoryRoot
    );

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8790,
      repositoryRoot,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      whiteshadowBaseUrl: "http://127.0.0.1:8787"
    });
    expect(config.whiteshadowPython).toBe(
      "D:\\whiteshadow-workspace\\local-llm-ws\\.venv\\Scripts\\python.exe"
    );
    expect(PINNED_OLLAMA_MODEL).toBe("qwen3:4b");
  });

  it("rejects non-loopback binding", () => {
    expect(() =>
      readConfig(
        {
          ORCHESTRATOR_HOST: "0.0.0.0",
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      )
    ).toThrow(/loopback host/u);
  });

  it("rejects a model override", () => {
    expect(() =>
      readConfig(
        {
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          OLLAMA_MODEL: "another-model",
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      )
    ).toThrow(`OLLAMA_MODEL must remain pinned to ${PINNED_OLLAMA_MODEL}`);
  });

  it("rejects credential-bearing upstream URLs", () => {
    expect(() =>
      readConfig(
        {
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          OLLAMA_BASE_URL: "http://user:secret@127.0.0.1:11434",
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      )
    ).toThrow(/credential-free/u);
  });

  it.each([
    ["ORCHESTRATOR_REPOSITORY_ROOT", "D:\\other-repository"],
    ["ORCHESTRATOR_EVIDENCE_ROOT", "D:\\outside-evidence"],
    ["OLLAMA_EXECUTABLE", "C:\\Tools\\other.exe"],
    ["WHITESHADOW_WORKSPACE", "D:\\other-whiteshadow"],
    ["WHITESHADOW_PYTHON", "D:\\other-whiteshadow\\python.exe"]
  ])("rejects redirected canonical path %s", (key, value) => {
    expect(() =>
      readConfig(
        {
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE,
          [key]: value
        },
        repositoryRoot
      )
    ).toThrow(/pinned|canonical/u);
  });
});
