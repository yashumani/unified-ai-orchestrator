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

  it("fails closed for unclassified or mutating capabilities", async () => {
    const client = new WhiteShadowClient({ fetch: vi.fn<typeof fetch>() });
    await expect(client.invoke("harness-run")).rejects.toThrow(/allowlist/u);
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
