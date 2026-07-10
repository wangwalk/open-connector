import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { dokployActionHandlers, normalizeDokployApiBaseUrl } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dokploy read-only provider", () => {
  it("validates an API key using a GET request and x-api-key", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse([]),
    );

    const result = await credentialValidators.apiKey?.(
      {
        apiKey: "dokploy-key",
        values: { apiKey: "dokploy-key", apiBaseUrl: "http://127.0.0.1:3000" },
      },
      { fetcher },
    );

    expect(result).toMatchObject({
      profile: { accountId: "127.0.0.1:3000" },
      metadata: { apiBaseUrl: "http://127.0.0.1:3000/api", projectCount: 0 },
    });
    const request = fetcher.mock.calls[0]!;
    expect(String(request[0])).toBe("http://127.0.0.1:3000/api/project.all");
    expect(request[1]).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({ "x-api-key": "dokploy-key" }),
    });
  });

  it("returns allowlisted application data and drops all known secret-bearing fields", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          applicationId: "app_1",
          name: "Web",
          appName: "web-prod",
          applicationStatus: "running",
          repository: "owner/repo",
          branch: "main",
          environment: "DATABASE_PASSWORD=must-not-leak",
          env: "TOKEN=must-not-leak",
          buildSecrets: { registryToken: "must-not-leak" },
          password: "must-not-leak",
          source: { repository: "owner/repo", accessToken: "must-not-leak" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["dokploy.get_application"]?.(
      { applicationId: "app_1" },
      {
        getCredential: async () => apiKeyCredential("dokploy-key", { apiBaseUrl: "http://127.0.0.1:3000/api" }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        application: {
          id: "app_1",
          name: "Web",
          appName: "web-prod",
          status: "running",
          repository: "owner/repo",
          branch: "main",
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|buildSecrets|password|registryToken|accessToken/);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });

  it("exposes only the approved read actions", () => {
    expect(Object.keys(dokployActionHandlers).sort()).toEqual([
      "get_application",
      "get_application_status",
      "get_deployments",
      "get_project",
      "list_applications",
      "list_projects",
      "list_services",
    ]);
    expect(Object.keys(dokployActionHandlers).join(" ")).not.toMatch(
      /(^| )(deploy|redeploy|restart|start|stop|delete|update|save_environment)( |$)/,
    );
  });

  it("normalizes the API suffix and rejects unsafe configured URLs", () => {
    expect(normalizeDokployApiBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/api");
    expect(normalizeDokployApiBaseUrl("https://dokploy.example.com/api/")).toBe("https://dokploy.example.com/api");
    expect(() => normalizeDokployApiBaseUrl("https://user:pass@dokploy.example.com")).toThrow("must not include");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
