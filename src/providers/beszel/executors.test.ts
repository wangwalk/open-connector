import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { beszelActionHandlers, normalizeBeszelBaseUrl } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Beszel read-only provider", () => {
  it("validates a dedicated readonly login without exposing the password", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          token: "pocketbase-token",
          record: { id: "user_1", email: "reader@example.com", role: "readonly" },
        }),
    );

    const result = await credentialValidators.customCredential?.(
      {
        values: {
          baseUrl: "https://beszel.example.com",
          email: "reader@example.com",
          password: "test-password",
        },
      },
      { fetcher },
    );

    expect(result).toMatchObject({
      profile: { accountId: "beszel.example.com:user_1", displayName: "reader@example.com" },
      metadata: { role: "readonly", baseUrl: "https://beszel.example.com" },
    });
    const request = fetcher.mock.calls[0]!;
    expect(String(request[0])).toBe("https://beszel.example.com/api/collections/users/auth-with-password");
    expect(request[1]).toMatchObject({ method: "POST" });
    expect(String(request[1]?.body)).toContain("test-password");
    expect(JSON.stringify(result)).not.toContain("test-password");
  });

  it("lists systems with a fixed GET query and allowlisted output", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          page: 1,
          perPage: 50,
          totalItems: 1,
          totalPages: 1,
          items: [
            {
              id: "system_1",
              name: "host",
              status: "up",
              host: "10.0.0.2",
              info: { os: "Linux", agentVersion: "0.18.7", token: "must-not-leak" },
              users: ["user_1"],
              password: "must-not-leak",
            },
          ],
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["beszel.list_systems"]?.(
      { status: "up" },
      {
        getCredential: async () => apiKeyCredential("pocketbase-token", { baseUrl: "https://beszel.example.com" }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        systems: [{ id: "system_1", name: "host", status: "up", info: { os: "Linux", agentVersion: "0.18.7" } }],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|password|token/);
    const request = fetcher.mock.calls[0]!;
    expect(String(request[0])).toContain("/api/collections/systems/records?");
    expect(request[1]).toMatchObject({ method: "GET" });
    expect(new Headers(request[1]?.headers).get("authorization")).toBe("pocketbase-token");
  });

  it("exposes only the four approved read actions", () => {
    expect(Object.keys(beszelActionHandlers).sort()).toEqual([
      "get_metrics",
      "get_system",
      "list_containers",
      "list_systems",
    ]);
  });

  it("rejects URLs with credentials or fragments", () => {
    expect(() => normalizeBeszelBaseUrl("https://user:pass@beszel.example.com")).toThrow("must not include");
    expect(() => normalizeBeszelBaseUrl("https://beszel.example.com/#other")).toThrow("must not include");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
