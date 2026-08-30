import { describe, expect, it, vi } from "vitest";
import { WhiteShadowClient } from "./client.js";

describe("WhiteShadowClient", () => {
  it("accepts only credential-free loopback HTTP", () => {
    expect(() => new WhiteShadowClient({ baseUrl: "https://127.0.0.1:8787" })).toThrow();
    expect(() => new WhiteShadowClient({ baseUrl: "http://example.com:8787" })).toThrow();
    expect(() => new WhiteShadowClient({ baseUrl: "http://user:secret@127.0.0.1:8787" })).toThrow();
  });

  it("uses GET and emits only an allowlisted summary", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          app: "whiteshadow-web",
          workspace: "D:/must-not-leak",
          credential: "must-not-leak"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = new WhiteShadowClient({ fetch: fetchMock });
    const result = await client.invoke("health");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(result.summary).toEqual({ status: "ok", app: "whiteshadow-web" });
  });

  it("discovers exactly four safe model-free GET capabilities", async () => {
    const expectedCapabilities = [
      {
        capabilityId: "health",
        name: "Health",
        description: "Read the localhost WhiteShadow web service health summary.",
        path: "/api/health"
      },
      {
        capabilityId: "runtime-summary",
        name: "Runtime summary",
        description: "Read a redacted WhiteShadow runtime summary without inference.",
        path: "/api/runtime"
      },
      {
        capabilityId: "skills-catalog",
        name: "Skills catalog",
        description: "Read WhiteShadow skill catalog counts without running a skill.",
        path: "/api/skills/catalog"
      },
      {
        capabilityId: "plugins-catalog",
        name: "Plugins catalog",
        description: "Read WhiteShadow plugin catalog counts without invoking a plugin.",
        path: "/api/plugins/catalog"
      }
    ] as const;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new WhiteShadowClient({ fetch: fetchMock });

    expect(client.listCapabilities()).toEqual(
      expectedCapabilities.map(({ path: _path, ...capability }) => ({
        ...capability,
        risk: "safe",
        modelUse: "none",
        mode: "read"
      }))
    );

    for (const capability of expectedCapabilities) {
      await client.invoke(capability.capabilityId);
    }

    expect(
      fetchMock.mock.calls.map(([input, init]) => ({
        url: String(input),
        method: init?.method
      }))
    ).toEqual(
      expectedCapabilities.map((capability) => ({
        url: `http://127.0.0.1:8787${capability.path}`,
        method: "GET"
      }))
    );
  });

  it("fails closed for unclassified or mutating capabilities", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new WhiteShadowClient({ fetch: fetchMock });

    await expect(client.invoke("harness-run")).rejects.toThrow(/allowlist/u);
    await expect(client.invoke("capability-catalog")).rejects.toThrow(/allowlist/u);
    expect(client.listCapabilities()).not.toContainEqual(
      expect.objectContaining({ capabilityId: "capability-catalog" })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an offline state instead of fabricating readiness", async () => {
    const client = new WhiteShadowClient({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"))
    });
    await expect(client.status()).resolves.toMatchObject({
      service: "whiteshadow",
      phase: "offline"
    });
  });
});
