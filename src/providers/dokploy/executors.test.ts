import { describe, expect, it, vi } from "vitest";
import { dokployOperations } from "./operations.ts";
import { executeDokployOperation, sanitizeDokployOutput } from "./runtime.ts";

describe("Dokploy output sanitization", () => {
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
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
