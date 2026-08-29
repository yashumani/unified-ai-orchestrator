import { PINNED_OLLAMA_MODEL } from "@unified-ai/contracts";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_DEPLOYMENT_RELEASES_ROOT,
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
      releaseSha: "development",
      repositoryRoot,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      whiteshadowBaseUrl: "http://127.0.0.1:8787"
    });
    expect(config.whiteshadowPython).toBe(
      "D:\\whiteshadow-workspace\\local-llm-ws\\.venv\\Scripts\\python.exe"
    );
    expect(PINNED_OLLAMA_MODEL).toBe("qwen3:4b");
  });

  it("accepts only a development marker or an exact lowercase release SHA", () => {
    const releaseSha = "deb2a583234af99043fd383ca59a7be0bbde8e29";
    const webDistRoot = `${CANONICAL_DEPLOYMENT_RELEASES_ROOT}\\${releaseSha}\\apps\\web\\dist`;
    expect(
      readConfig(
        {
          ORCHESTRATOR_RELEASE_SHA: releaseSha,
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          ORCHESTRATOR_WEB_DIST_ROOT: webDistRoot,
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      ).releaseSha
    ).toBe(releaseSha);

    expect(() =>
      readConfig(
        {
          ORCHESTRATOR_RELEASE_SHA: "latest",
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      )
    ).toThrow(/RELEASE_SHA/u);
  });

  it("accepts only an exact versioned deployment web bundle", () => {
    const releaseSha = "deb2a583234af99043fd383ca59a7be0bbde8e29";
    const webDistRoot = `${CANONICAL_DEPLOYMENT_RELEASES_ROOT}\\${releaseSha}\\apps\\web\\dist`;
    expect(
      readConfig(
        {
          ORCHESTRATOR_RELEASE_SHA: releaseSha,
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          ORCHESTRATOR_WEB_DIST_ROOT: webDistRoot,
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      ).webDistRoot
    ).toBe(webDistRoot);

    for (const invalid of [
      "D:\\outside\\apps\\web\\dist",
      `${CANONICAL_DEPLOYMENT_RELEASES_ROOT}\\latest\\apps\\web\\dist`,
      `${CANONICAL_DEPLOYMENT_RELEASES_ROOT}\\${releaseSha}\\apps\\api\\dist`
    ]) {
      expect(() =>
        readConfig(
          {
            ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
            ORCHESTRATOR_WEB_DIST_ROOT: invalid,
            OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
            WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
          },
          repositoryRoot
        )
      ).toThrow(/WEB_DIST_ROOT/u);
    }
  });

  it("requires the readiness SHA and release web bundle SHA to match", () => {
    const firstSha = "a".repeat(40);
    const secondSha = "b".repeat(40);
    const releaseWebDist = `${CANONICAL_DEPLOYMENT_RELEASES_ROOT}\\${secondSha}\\apps\\web\\dist`;

    expect(() =>
      readConfig(
        {
          ORCHESTRATOR_RELEASE_SHA: firstSha,
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          ORCHESTRATOR_WEB_DIST_ROOT: releaseWebDist,
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      )
    ).toThrow(/same release/u);

    expect(() =>
      readConfig(
        {
          ORCHESTRATOR_REPOSITORY_ROOT: repositoryRoot,
          ORCHESTRATOR_WEB_DIST_ROOT: releaseWebDist,
          OLLAMA_EXECUTABLE: CANONICAL_OLLAMA_EXECUTABLE,
          WHITESHADOW_WORKSPACE: CANONICAL_WHITESHADOW_WORKSPACE
        },
        repositoryRoot
      )
    ).toThrow(/same release/u);
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
