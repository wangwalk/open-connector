import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential, customCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { normalizeUmamiApiBaseUrl } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Umami self-hosted credentials", () => {
  it("validates a Bearer token against the configured self-hosted URL", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ id: "user_1", username: "reader" }),
    );

    const result = await credentialValidators.apiKey?.(
      { apiKey: "token", values: { apiKey: "token", apiBaseUrl: "https://stats.example.com/api" } },
      { fetcher },
    );

    expect(result).toMatchObject({
      profile: { accountId: "stats.example.com:user_1", displayName: "reader" },
      metadata: { apiBaseUrl: "https://stats.example.com" },
    });
    const request = fetcher.mock.calls[0]!;
    expect(String(request[0])).toBe("https://stats.example.com/api/auth/verify");
    expect(request[1]).toMatchObject({ method: "POST" });
    expect(new Headers(request[1]?.headers).get("authorization")).toBe("Bearer token");
  });

  it("logs in with custom credentials and uses the returned token for read actions", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/auth/login")) {
        return jsonResponse({ token: "session-token", user: { id: "user_1", username: "reader" } });
      }
      return jsonResponse({
        token: "must-not-leak",
        password: "must-not-leak",
        user: {
          id: "user_1",
          username: "reader",
          role: "user",
          token: "must-not-leak",
        },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["umami.get_current_user"]?.(
      {},
      {
        getCredential: async () =>
          customCredential({
            baseUrl: "https://stats.example.com",
            username: "reader",
            password: "test-password",
          }),
      },
    );

    expect(result).toMatchObject({ ok: true, output: { user: { id: "user_1", username: "reader" } } });
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|token|password|raw/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: "GET" });
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer session-token");
  });

  it("keeps Cloud as the default API-key endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => jsonResponse({ id: "cloud-user" })),
    );

    const result = await executors["umami.get_current_user"]?.(
      {},
      { getCredential: async () => apiKeyCredential("cloud-key") },
    );

    expect(result).toMatchObject({ ok: true });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("https://api.umami.is/api/me");
  });

  it("rejects configured URLs that contain embedded credentials or query parameters", () => {
    expect(() => normalizeUmamiApiBaseUrl("https://user:pass@stats.example.com")).toThrow("must not include");
    expect(() => normalizeUmamiApiBaseUrl("https://stats.example.com?target=other")).toThrow("must not include");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
