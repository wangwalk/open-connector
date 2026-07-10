import type { CredentialValidationResult } from "../../core/types.ts";
import type { UmamiActionName } from "./actions.ts";

import { compactObject, optionalBoolean, optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

export const umamiCloudApiBaseUrl = "https://api.umami.is";
export const umamiValidationPath = "/api/auth/verify";
export const umamiLoginPath = "/api/auth/login";

export interface UmamiProviderContext {
  apiBaseUrl: string;
  accessToken: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export interface UmamiLoginResult {
  apiBaseUrl: string;
  accessToken: string;
  user: Record<string, unknown>;
}

type UmamiActionHandler = (input: Record<string, unknown>, context: UmamiProviderContext) => Promise<unknown>;

interface UmamiRequestOptions {
  path: string;
  apiBaseUrl: string;
  accessToken?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  mode: "validate" | "execute";
  method?: "GET" | "POST";
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
}

export const umamiActionHandlers: Record<UmamiActionName, UmamiActionHandler> = {
  async get_current_user(_input, context) {
    const user = requireObject(
      await requestUmamiJson({
        path: "/api/me",
        ...context,
        mode: "execute",
      }),
      "Umami returned an invalid user payload",
    );
    return { user: normalizeUmamiUser(user) };
  },
  async list_websites(input, context) {
    const payload = requireObject(
      await requestUmamiJson({
        path: "/api/websites",
        ...context,
        mode: "execute",
        query: {
          query: optionalString(input.query),
          page: optionalIntegerString(input.page),
          pageSize: optionalIntegerString(input.pageSize),
        },
      }),
      "Umami returned an invalid website list payload",
    );
    return {
      websites: objectArray(payload.data, "Umami returned an invalid website list data payload").map(
        normalizeUmamiWebsite,
      ),
      count: readNonNegativeInteger(payload.count, "count"),
      page: readPositiveInteger(payload.page, "page"),
      pageSize: readPositiveInteger(payload.pageSize, "pageSize"),
    };
  },
  async get_website(input, context) {
    const websiteId = requiredInputString(input.websiteId, "websiteId");
    const website = requireObject(
      await requestUmamiJson({
        path: `/api/websites/${encodeURIComponent(websiteId)}`,
        ...context,
        mode: "execute",
      }),
      "Umami returned an invalid website payload",
    );
    return { website: normalizeUmamiWebsite(website) };
  },
  async get_website_stats(input, context) {
    const websiteId = requiredInputString(input.websiteId, "websiteId");
    const stats = requireObject(
      await requestUmamiJson({
        path: `/api/websites/${encodeURIComponent(websiteId)}/stats`,
        ...context,
        mode: "execute",
        query: buildDateRangeQuery(input),
      }),
      "Umami returned an invalid stats payload",
    );
    return { stats: sanitizeAnalyticsRecord(stats) };
  },
  async get_pageviews(input, context) {
    const websiteId = requiredInputString(input.websiteId, "websiteId");
    const pageviews = requireObject(
      await requestUmamiJson({
        path: `/api/websites/${encodeURIComponent(websiteId)}/pageviews`,
        ...context,
        mode: "execute",
        query: {
          ...buildDateRangeQuery(input),
          unit: optionalString(input.unit),
        },
      }),
      "Umami returned an invalid pageviews payload",
    );
    return { pageviews: sanitizeAnalyticsRecord(pageviews) };
  },
  async get_metrics(input, context) {
    const websiteId = requiredInputString(input.websiteId, "websiteId");
    const metrics = objectArray(
      await requestUmamiJson({
        path: `/api/websites/${encodeURIComponent(websiteId)}/metrics`,
        ...context,
        mode: "execute",
        query: {
          ...buildDateRangeQuery(input),
          type: requiredInputString(input.type, "type"),
          limit: optionalIntegerString(input.limit),
        },
      }),
      "Umami returned an invalid metrics payload",
    );
    return { metrics: metrics.map(normalizeUmamiMetric) };
  },
  async get_realtime(input, context) {
    const websiteId = requiredInputString(input.websiteId, "websiteId");
    const realtime = requireObject(
      await requestUmamiJson({
        path: `/api/realtime/${encodeURIComponent(websiteId)}`,
        ...context,
        mode: "execute",
      }),
      "Umami returned an invalid realtime payload",
    );
    return { realtime: sanitizeAnalyticsRecord(realtime) };
  },
  async list_events(input, context) {
    const websiteId = requiredInputString(input.websiteId, "websiteId");
    const payload = requireObject(
      await requestUmamiJson({
        path: `/api/websites/${encodeURIComponent(websiteId)}/events`,
        ...context,
        mode: "execute",
        query: {
          ...buildDateRangeQuery(input),
          query: optionalString(input.query),
          page: optionalIntegerString(input.page),
          pageSize: optionalIntegerString(input.pageSize),
        },
      }),
      "Umami returned an invalid event list payload",
    );
    return {
      events: objectArray(payload.data, "Umami returned an invalid event list data payload").map(normalizeUmamiEvent),
      count: readNonNegativeInteger(payload.count, "count"),
      page: readPositiveInteger(payload.page, "page"),
      pageSize: readPositiveInteger(payload.pageSize, "pageSize"),
    };
  },
};

export async function validateUmamiCredential(
  accessToken: string,
  apiBaseUrl: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const user = requireObject(
    await requestUmamiJson({
      path: umamiValidationPath,
      apiBaseUrl,
      accessToken,
      fetcher,
      signal,
      mode: "validate",
      method: "POST",
    }),
    "Umami returned an invalid credential payload",
  );

  return buildUmamiValidationResult(user, apiBaseUrl);
}

export async function loginUmami(
  baseUrl: string,
  username: string,
  password: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<UmamiLoginResult> {
  const apiBaseUrl = normalizeUmamiApiBaseUrl(baseUrl);
  const payload = requireObject(
    await requestUmamiJson({
      path: umamiLoginPath,
      apiBaseUrl,
      fetcher,
      signal,
      mode: "validate",
      method: "POST",
      body: { username, password },
    }),
    "Umami returned an invalid login payload",
  );
  const accessToken = optionalString(payload.token);
  if (!accessToken) {
    throw new ProviderRequestError(502, "Umami login response did not include a token");
  }
  const user = optionalRecord(payload.user) ?? payload;
  return { apiBaseUrl, accessToken, user };
}

export function buildUmamiValidationResult(
  user: Record<string, unknown>,
  apiBaseUrl: string,
): CredentialValidationResult {
  const profile = optionalRecord(user.user) ?? user;
  const userId = optionalString(profile.id);
  const username = optionalString(profile.username);
  return {
    profile: {
      accountId: `${new URL(apiBaseUrl).host}:${userId ?? username ?? "api-key"}`,
      displayName: username ?? userId ?? "Umami API Key",
    },
    grantedScopes: [],
    metadata: {
      apiBaseUrl,
      validationEndpoint: umamiValidationPath,
      userId,
      username,
      role: optionalString(profile.role),
    },
  };
}

export function normalizeUmamiApiBaseUrl(value: unknown): string {
  const raw = optionalString(value) ?? umamiCloudApiBaseUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRequestError(400, "Umami URL must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRequestError(400, "Umami URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "Umami URL must not include credentials, query parameters, or fragments");
  }
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/api$/u, "");
  url.pathname = path || "/";
  return url.toString().replace(/\/$/u, "");
}

async function requestUmamiJson(options: UmamiRequestOptions): Promise<unknown> {
  const url = new URL(options.path.replace(/^\/+/, ""), `${options.apiBaseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  const headers = new Headers({
    accept: "application/json",
    "user-agent": providerUserAgent,
  });
  if (options.accessToken) {
    headers.set("authorization", `Bearer ${options.accessToken}`);
  }
  let body: string | undefined;
  if (options.body) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await options.fetcher(url, {
    method: options.method ?? "GET",
    headers,
    body,
    signal: options.signal,
  });
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw mapUmamiError(response.status, payload, options.mode);
  }

  return payload;
}

function normalizeUmamiUser(payload: Record<string, unknown>): Record<string, unknown> {
  const user = optionalRecord(payload.user) ?? payload;
  return compactObject({
    id: optionalString(user.id),
    username: optionalString(user.username),
    role: optionalString(user.role),
    isAdmin: optionalBoolean(user.isAdmin),
  });
}

function normalizeUmamiWebsite(website: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    id: optionalString(website.id),
    name: optionalString(website.name),
    domain: optionalString(website.domain),
    shareId: optionalString(website.shareId) ?? null,
    createdAt: optionalString(website.createdAt),
    updatedAt: optionalString(website.updatedAt),
  });
}

function normalizeUmamiMetric(metric: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    x: sanitizeAnalyticsValue(metric.x),
    y: typeof metric.y === "number" && Number.isFinite(metric.y) ? metric.y : undefined,
  });
}

function normalizeUmamiEvent(event: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    id: optionalString(event.id),
    websiteId: optionalString(event.websiteId),
    sessionId: optionalString(event.sessionId),
    eventName: optionalString(event.eventName),
    urlPath: optionalString(event.urlPath),
    createdAt: optionalString(event.createdAt),
  });
}

function sanitizeAnalyticsRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeAnalyticsValue(record);
  return optionalRecord(sanitized) ?? {};
}

function sanitizeAnalyticsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAnalyticsValue);
  const record = optionalRecord(value);
  if (!record) return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (isSensitiveUmamiKey(key)) continue;
    output[key] = sanitizeAnalyticsValue(item);
  }
  return output;
}

function isSensitiveUmamiKey(key: string): boolean {
  return /token|password|secret|authorization|api[_-]?key|private[_-]?key/iu.test(key);
}

function buildDateRangeQuery(input: Record<string, unknown>): Record<string, string | undefined> {
  return {
    startAt: integerString(input.startAt, "startAt"),
    endAt: integerString(input.endAt, "endAt"),
    timezone: requiredInputString(input.timezone, "timezone"),
    url: optionalString(input.url),
    referrer: optionalString(input.referrer),
    title: optionalString(input.title),
    host: optionalString(input.host),
    os: optionalString(input.os),
    browser: optionalString(input.browser),
    device: optionalString(input.device),
    country: optionalString(input.country),
    region: optionalString(input.region),
    city: optionalString(input.city),
  };
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      message: text,
    };
  }
}

function mapUmamiError(status: number, payload: unknown, mode: "validate" | "execute"): ProviderRequestError {
  const message = readErrorMessage(payload) ?? `Umami API request failed with status ${status}`;
  if (status === 401 || status === 403) {
    return new ProviderRequestError(mode === "validate" ? 400 : 401, message, payload);
  }
  if (status === 404) {
    return new ProviderRequestError(404, message, payload);
  }
  if (status === 429) {
    return new ProviderRequestError(429, message, payload);
  }
  if (status === 400 || status === 422) {
    return new ProviderRequestError(400, message, payload);
  }
  return new ProviderRequestError(502, message, payload);
}

function readErrorMessage(payload: unknown): string | undefined {
  const body = optionalRecord(payload);
  if (!body) {
    return undefined;
  }

  if (typeof body.error === "string" && body.error) {
    return body.error;
  }
  const errorObject = optionalRecord(body.error);
  const errorMessage = optionalString(errorObject?.message);
  if (errorMessage) {
    return errorMessage;
  }

  return optionalString(body.message);
}

function requireObject(value: unknown, errorMessage: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) {
    throw new ProviderRequestError(502, errorMessage, value);
  }
  return record;
}

function objectArray(value: unknown, errorMessage: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new ProviderRequestError(502, errorMessage, value);
  }
  return value.map((item) => requireObject(item, errorMessage));
}

function requiredInputString(value: unknown, fieldName: string): string {
  const text = optionalString(value);
  if (!text) {
    throw new ProviderRequestError(400, `${fieldName} is required`);
  }
  return text;
}

function integerString(value: unknown, fieldName: string): string {
  const parsed = optionalInteger(value);
  if (parsed === undefined) {
    throw new ProviderRequestError(400, `${fieldName} must be an integer`);
  }
  return String(parsed);
}

function optionalIntegerString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = optionalInteger(value);
  if (parsed === undefined) {
    throw new ProviderRequestError(400, "optional integer input must be an integer");
  }
  return String(parsed);
}

function readPositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ProviderRequestError(502, `Umami returned an invalid ${fieldName} payload`, value);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProviderRequestError(502, `Umami returned an invalid ${fieldName} payload`, value);
  }
  return value;
}
