import { afterEach, describe, expect, it, vi } from "vitest";
import { setPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { dokployActions } from "./actions.ts";
import { credentialValidators } from "./executors.ts";
import { dokployOperations } from "./operations.ts";
import {
  createDokployContext,
  executeDokployOperation,
  normalizeDokployApiBaseUrl,
  sanitizeDokployOutput,
} from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  setPrivateNetworkAccessAllowed(false);
});

describe("Dokploy merged provider", () => {
  it("keeps the complete official operation catalog", () => {
    expect(dokployActions).toHaveLength(dokployOperations.length);
    expect(dokployActions.map((action) => action.name)).toEqual(
      expect.arrayContaining(["application-one", "application-deploy", "project-search", "settings-reloadServer"]),
    );
  });

  it("validates legacy apiBaseUrl credentials with the official x-api-key flow", async () => {
    setPrivateNetworkAccessAllowed(true);
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonResponse([]),
    );

    const result = await credentialValidators.apiKey?.(
      {
        apiKey: "dokploy-key",
        values: { apiKey: "dokploy-key", apiBaseUrl: "http://10.0.0.5:3000/api" },
      },
      { fetcher },
    );

    expect(result).toMatchObject({
      profile: { accountId: "dokploy:10.0.0.5:3000" },
      metadata: { apiBaseUrl: "http://10.0.0.5:3000/api", validationEndpoint: "/project.search" },
    });
    const request = fetcher.mock.calls[0]!;
    expect(String(request[0])).toBe("http://10.0.0.5:3000/api/project.search?limit=1&offset=0");
    expect(request[1]).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({ "x-api-key": "dokploy-key" }),
    });
  });

  it("reads legacy apiBaseUrl metadata when creating an action context", () => {
    const context = createDokployContext({}, "dokploy-key", fetch, undefined, undefined, {
      apiBaseUrl: "https://dokploy.example.com/api",
    });

    expect(context.apiBaseUrl).toBe("https://dokploy.example.com/api");
  });

  it("drops secret-bearing fields from official operation responses", async () => {
    const operation = dokployOperations.find((candidate) => candidate.name === "application-one");
    expect(operation).toBeDefined();
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          applicationId: "app_1",
          name: "Web",
          repository: "owner/repo",
          environmentId: "env_1",
          environment: "DATABASE_PASSWORD=must-not-leak",
          env: "TOKEN=must-not-leak",
          buildSecrets: { registryToken: "must-not-leak" },
          password: "must-not-leak",
          source: { repository: "owner/repo", accessToken: "must-not-leak" },
        }),
    );

    const result = await executeDokployOperation(
      operation!,
      { applicationId: "app_1" },
      {
        apiBaseUrl: "https://dokploy.example.com/api",
        apiKey: "dokploy-key",
        fetcher,
      },
    );

    expect(result).toEqual({
      applicationId: "app_1",
      name: "Web",
      repository: "owner/repo",
      environmentId: "env_1",
      source: { repository: "owner/repo" },
    });
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|buildSecrets|password|registryToken|accessToken/u);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://dokploy.example.com/api/application.one?applicationId=app_1",
    );
  });

  it("sanitizes nested arrays without mutating safe fields", () => {
    expect(
      sanitizeDokployOutput({
        projects: [{ id: "project_1", apiKey: "must-not-leak", settings: { cookie: "must-not-leak" } }],
      }),
    ).toEqual({ projects: [{ id: "project_1", settings: {} }] });
  });

  it("normalizes the API suffix and retains official unsafe-target checks", () => {
    expect(normalizeDokployApiBaseUrl("https://dokploy.example.com/api/")).toBe("https://dokploy.example.com/api");
    expect(() => normalizeDokployApiBaseUrl("https://user:pass@dokploy.example.com")).toThrow("credentials");
    expect(() => normalizeDokployApiBaseUrl("http://169.254.169.254")).toThrow();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
