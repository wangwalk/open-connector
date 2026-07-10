import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { credentialValidators, executors } from "./executors.ts";
import { normalizePlausibleBaseUrl, plausibleAnalyticsActionHandlers } from "./runtime.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Plausible read-only Agent analytics provider", () => {
  it("validates a self-hosted Stats API key without exposing it", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => statsResponse([[7]], []),
    );

    const result = await credentialValidators.apiKey?.(
      {
        apiKey: "plausible-secret",
        values: { siteId: "example.com", baseUrl: "https://plausible.example.com" },
      },
      { fetcher },
    );

    expect(result).toMatchObject({
      profile: {
        accountId: "plausible:plausible.example.com:example.com",
        displayName: "Plausible example.com",
      },
      metadata: {
        baseUrl: "https://plausible.example.com",
        siteId: "example.com",
        validationEndpoint: "/api/v2/query",
      },
    });
    expect(JSON.stringify(result)).not.toContain("plausible-secret");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://plausible.example.com/api/v2/query");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer plausible-secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      site_id: "example.com",
      date_range: "7d",
      metrics: ["visitors"],
      pagination: { limit: 1, offset: 0 },
    });
  });

  it("returns a named overview without raw provider payloads", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        statsResponse([[120, 130, 260, 2, 35.5, 95]], [], {
          query: {
            site_id: "example.com",
            date_range: ["2026-07-04T00:00:00Z", "2026-07-10T23:59:59Z"],
          },
          meta: { private_token: "must-not-leak" },
          extra: { password: "must-not-leak" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["plausible_analytics.get_overview"]?.(
      { date_range: "7d" },
      {
        getCredential: async () =>
          apiKeyCredential("plausible-secret", {
            siteId: "example.com",
            baseUrl: "https://plausible.example.com",
          }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        site_id: "example.com",
        date_range: ["2026-07-04T00:00:00Z", "2026-07-10T23:59:59Z"],
        metrics: ["visitors", "visits", "pageviews", "views_per_visit", "bounce_rate", "visit_duration"],
        dimensions: [],
        rows: [
          {
            dimensions: {},
            metrics: {
              visitors: 120,
              visits: 130,
              pageviews: 260,
              views_per_visit: 2,
              bounce_rate: 35.5,
              visit_duration: 95,
            },
          },
        ],
        total_rows: null,
        time_labels: [],
        warnings: [],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|private_token|password|raw/);
  });

  it("maps bounded filters and normalized breakdown rows", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        statsResponse([[42], [30]], [["Search"], ["Direct / None"]], {
          meta: { total_rows: 2 },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["plausible_analytics.get_breakdown"]?.(
      {
        date_range: "30d",
        metrics: ["visitors"],
        dimension: "visit:channel",
        filters: [
          {
            operator: "contains",
            dimension: "event:page",
            values: ["/docs"],
            case_sensitive: false,
          },
        ],
        limit: 20,
      },
      {
        getCredential: async () => apiKeyCredential("secret", { siteId: "example.com" }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        rows: [
          { dimensions: { "visit:channel": "Search" }, metrics: { visitors: 42 } },
          { dimensions: { "visit:channel": "Direct / None" }, metrics: { visitors: 30 } },
        ],
        total_rows: 2,
      },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      site_id: "example.com",
      date_range: "30d",
      metrics: ["visitors"],
      dimensions: ["visit:channel"],
      filters: [["contains", "event:page", ["/docs"], { case_sensitive: false }]],
      order_by: [["visitors", "desc"]],
      include: { total_rows: true },
      pagination: { limit: 20, offset: 0 },
    });
  });

  it("calculates deterministic period comparisons with a zero-baseline guard", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { date_range: string };
      return body.date_range === "7d" ? statsResponse([[120, 0]], []) : statsResponse([[100, 0]], []);
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["plausible_analytics.compare_periods"]?.(
      {
        current_date_range: "7d",
        comparison_date_range: "28d",
        metrics: ["visitors", "events"],
      },
      {
        getCredential: async () => apiKeyCredential("secret", { siteId: "example.com" }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        comparisons: [
          {
            metric: "visitors",
            current: 120,
            comparison: 100,
            absolute_change: 20,
            percent_change: 20,
          },
          {
            metric: "events",
            current: 0,
            comparison: 0,
            absolute_change: 0,
            percent_change: null,
          },
        ],
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ranks only positive-growth dimension values", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { date_range: string };
      return body.date_range === "7d"
        ? statsResponse([[80], [20], [5]], [["Search"], ["Newsletter"], ["Declining"]])
        : statsResponse([[50], [0], [10]], [["Search"], ["Newsletter"], ["Declining"]]);
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["plausible_analytics.find_growth_opportunities"]?.(
      {
        current_date_range: "7d",
        comparison_date_range: "28d",
        metric: "visitors",
        dimension: "visit:source",
        limit: 5,
      },
      {
        getCredential: async () => apiKeyCredential("secret", { siteId: "example.com" }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        opportunities: [
          {
            dimension_value: "Search",
            current: 80,
            comparison: 50,
            absolute_change: 30,
            percent_change: 60,
            status: "growing",
          },
          {
            dimension_value: "Newsletter",
            current: 20,
            comparison: 0,
            absolute_change: 20,
            percent_change: null,
            status: "new",
          },
        ],
      },
    });
  });

  it("rejects arbitrary filter dimensions before making a request", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => statsResponse([], []));
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["plausible_analytics.get_overview"]?.(
      {
        date_range: "7d",
        filters: [{ operator: "is", dimension: "event:props:secret", values: ["x"] }],
      },
      {
        getCredential: async () => apiKeyCredential("secret", { siteId: "example.com" }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "filters[0].dimension is not supported",
        details: { status: 400 },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes only the six approved read actions", () => {
    expect(Object.keys(plausibleAnalyticsActionHandlers).sort()).toEqual([
      "compare_periods",
      "find_growth_opportunities",
      "get_breakdown",
      "get_overview",
      "get_timeseries",
      "query_stats",
    ]);
  });

  it("rejects base URLs with credentials, fragments, or insecure HTTP", () => {
    expect(() => normalizePlausibleBaseUrl("https://user:pass@plausible.example.com")).toThrow("must not include");
    expect(() => normalizePlausibleBaseUrl("https://plausible.example.com/#other")).toThrow("must not include");
    expect(() => normalizePlausibleBaseUrl("http://plausible.example.com")).toThrow("must use https");
  });
});

function statsResponse(
  metricRows: unknown[][],
  dimensionRows: unknown[][],
  options: {
    query?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      results: metricRows.map((metrics, index) => ({
        metrics,
        dimensions: dimensionRows[index] ?? [],
      })),
      query: options.query ?? {},
      meta: options.meta ?? {},
      ...options.extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
