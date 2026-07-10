import type { CredentialValidationResult } from "../../core/types.ts";
import type { BeszelActionName } from "./actions.ts";

import {
  optionalInteger,
  optionalNumber,
  optionalRecord,
  optionalString,
  requiredRecord,
  requiredString,
} from "../../core/cast.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

const requestTimeoutMs = 30_000;
const loginPath = "/api/collections/users/auth-with-password";
const refreshPath = "/api/collections/users/auth-refresh";
const safeSystemInfoKeys = [
  "hostname",
  "kernel",
  "os",
  "platform",
  "architecture",
  "arch",
  "cpuModel",
  "cores",
  "threads",
  "memory",
  "disk",
  "version",
  "agentVersion",
] as const;

export interface BeszelContext {
  baseUrl: string;
  token: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

interface BeszelLoginResult {
  baseUrl: string;
  token: string;
  user: Record<string, unknown>;
}

type BeszelActionHandler = (input: Record<string, unknown>, context: BeszelContext) => Promise<unknown>;

export const beszelActionHandlers: Record<BeszelActionName, BeszelActionHandler> = {
  async list_systems(input, context) {
    const page = boundedInteger(input.page, "page", 1, 10_000, 1);
    const pageSize = boundedInteger(input.pageSize, "pageSize", 1, 100, 50);
    const status = optionalString(input.status);
    const payload = await listBeszelRecords(context, "systems", {
      page,
      perPage: pageSize,
      sort: "name",
      filter: status ? `status = ${pocketBaseQuoted(status)}` : undefined,
    });
    return {
      systems: payload.items.map(normalizeBeszelSystem),
      page: payload.page,
      pageSize: payload.perPage,
      totalItems: payload.totalItems,
      totalPages: payload.totalPages,
    };
  },
  async get_system(input, context) {
    const systemId = requiredProviderString(input.systemId, "systemId");
    const payload = requiredRecord(
      await requestBeszelJson({
        ...context,
        path: `/api/collections/systems/records/${encodeURIComponent(systemId)}`,
        phase: "execute",
      }),
      "Beszel system response",
      providerError,
    );
    return { system: normalizeBeszelSystem(payload) };
  },
  async list_containers(input, context) {
    const systemId = requiredProviderString(input.systemId, "systemId");
    const page = boundedInteger(input.page, "page", 1, 10_000, 1);
    const pageSize = boundedInteger(input.pageSize, "pageSize", 1, 100, 50);
    const payload = await listBeszelRecords(context, "containers", {
      page,
      perPage: pageSize,
      sort: "name",
      filter: `system = ${pocketBaseQuoted(systemId)}`,
    });
    return {
      containers: payload.items.map(normalizeBeszelContainer),
      page: payload.page,
      pageSize: payload.perPage,
      totalItems: payload.totalItems,
      totalPages: payload.totalPages,
    };
  },
  async get_metrics(input, context) {
    const systemId = requiredProviderString(input.systemId, "systemId");
    const kind = requiredProviderString(input.kind, "kind");
    if (kind !== "system" && kind !== "container") {
      throw new ProviderRequestError(400, "kind must be system or container");
    }
    const resolution = requiredProviderString(input.resolution, "resolution");
    const maxPoints = boundedInteger(input.maxPoints, "maxPoints", 1, 500, 200);
    const filters = [`system = ${pocketBaseQuoted(systemId)}`, `type = ${pocketBaseQuoted(resolution)}`];
    const startAt = optionalPocketBaseDate(input.startAt, "startAt");
    const endAt = optionalPocketBaseDate(input.endAt, "endAt");
    if (startAt) filters.push(`created >= ${pocketBaseQuoted(startAt)}`);
    if (endAt) filters.push(`created <= ${pocketBaseQuoted(endAt)}`);

    const payload = await listBeszelRecords(context, kind === "system" ? "system_stats" : "container_stats", {
      page: 1,
      perPage: maxPoints,
      sort: "created",
      filter: filters.join(" && "),
    });
    return {
      kind,
      systemId,
      resolution,
      points: payload.items.map(normalizeMetricPoint),
      totalItems: payload.totalItems,
    };
  },
};

export async function loginBeszel(
  baseUrlInput: unknown,
  emailInput: unknown,
  passwordInput: unknown,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<BeszelLoginResult> {
  const baseUrl = normalizeBeszelBaseUrl(baseUrlInput);
  const email = requiredString(emailInput, "email", providerError);
  const password = requiredString(passwordInput, "password", providerError);
  const payload = requiredRecord(
    await requestBeszelJson({
      baseUrl,
      fetcher,
      signal,
      path: loginPath,
      phase: "validate",
      method: "POST",
      body: { identity: email, password },
    }),
    "Beszel login response",
    providerError,
  );
  const token = requiredString(payload.token, "Beszel auth token", providerError);
  const user = requiredRecord(payload.record, "Beszel user record", providerError);
  return { baseUrl, token, user };
}

export async function validateBeszelToken(
  baseUrlInput: unknown,
  token: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const baseUrl = normalizeBeszelBaseUrl(baseUrlInput);
  const payload = requiredRecord(
    await requestBeszelJson({
      baseUrl,
      token,
      fetcher,
      signal,
      path: refreshPath,
      phase: "validate",
      method: "POST",
    }),
    "Beszel auth refresh response",
    providerError,
  );
  return buildBeszelValidationResult(requiredRecord(payload.record, "Beszel user record", providerError), baseUrl);
}

export function buildBeszelValidationResult(
  user: Record<string, unknown>,
  baseUrl: string,
): CredentialValidationResult {
  const id = optionalString(user.id) ?? "user";
  const email = optionalString(user.email);
  return {
    profile: {
      accountId: `${new URL(baseUrl).host}:${id}`,
      displayName: email ?? `Beszel User ${id}`,
    },
    grantedScopes: [],
    metadata: {
      baseUrl,
      userId: id,
      email,
      role: optionalString(user.role),
    },
  };
}

export function normalizeBeszelBaseUrl(value: unknown): string {
  const raw = requiredString(value, "baseUrl", providerError);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRequestError(400, "Beszel URL must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRequestError(400, "Beszel URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "Beszel URL must not include credentials, query parameters, or fragments");
  }
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/api$/u, "");
  url.pathname = path || "/";
  return url.toString().replace(/\/$/u, "");
}

interface BeszelListResult {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: Array<Record<string, unknown>>;
}

async function listBeszelRecords(
  context: BeszelContext,
  collection: "systems" | "containers" | "system_stats" | "container_stats",
  query: { page: number; perPage: number; sort: string; filter?: string },
): Promise<BeszelListResult> {
  const payload = requiredRecord(
    await requestBeszelJson({
      ...context,
      path: `/api/collections/${collection}/records`,
      phase: "execute",
      query,
    }),
    `Beszel ${collection} response`,
    providerError,
  );
  if (!Array.isArray(payload.items)) {
    throw new ProviderRequestError(502, `Beszel ${collection} response did not include an items array`);
  }
  return {
    page: readNonNegativeInteger(payload.page, "page") || 1,
    perPage: readNonNegativeInteger(payload.perPage, "perPage"),
    totalItems: readNonNegativeInteger(payload.totalItems, "totalItems"),
    totalPages: readNonNegativeInteger(payload.totalPages, "totalPages"),
    items: payload.items.map((item) => requiredRecord(item, `${collection} item`, providerError)),
  };
}

interface BeszelRequestOptions {
  baseUrl: string;
  token?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  path: string;
  phase: "validate" | "execute";
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
}

async function requestBeszelJson(options: BeszelRequestOptions): Promise<unknown> {
  const url = new URL(options.path.replace(/^\/+/, ""), `${options.baseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers = new Headers({ accept: "application/json", "user-agent": providerUserAgent });
  if (options.token) headers.set("authorization", options.token);
  let body: string | undefined;
  if (options.body) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const timeoutSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])
    : AbortSignal.timeout(requestTimeoutMs);
  let response: Response;
  try {
    response = await options.fetcher(url, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: timeoutSignal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new ProviderRequestError(504, "Beszel request timed out", error);
    }
    throw new ProviderRequestError(502, "Beszel request failed", error);
  }
  const payload = await readJsonPayload(response);
  if (!response.ok) throw mapBeszelError(response.status, payload, options.phase);
  return payload;
}

function normalizeBeszelSystem(record: Record<string, unknown>): Record<string, unknown> {
  const sourceInfo = optionalRecord(record.info) ?? {};
  const info: Record<string, unknown> = {};
  for (const key of safeSystemInfoKeys) {
    const value = sourceInfo[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") info[key] = value;
  }
  return {
    id: optionalString(record.id) ?? "",
    name: optionalString(record.name) ?? "",
    status: optionalString(record.status) ?? null,
    host: optionalString(record.host) ?? null,
    port: optionalString(record.port) ?? null,
    created: optionalString(record.created) ?? null,
    updated: optionalString(record.updated) ?? null,
    info,
  };
}

function normalizeBeszelContainer(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: optionalString(record.id) ?? "",
    systemId: optionalString(record.system) ?? "",
    name: optionalString(record.name) ?? null,
    status: optionalString(record.status) ?? null,
    health: optionalNumber(record.health) ?? null,
    cpu: optionalNumber(record.cpu) ?? null,
    memory: optionalNumber(record.memory) ?? null,
    network: optionalNumber(record.net) ?? null,
    image: optionalString(record.image) ?? null,
    ports: optionalString(record.ports) ?? null,
    updated: optionalNumber(record.updated) ?? null,
  };
}

function normalizeMetricPoint(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: optionalString(record.id) ?? "",
    systemId: optionalString(record.system) ?? "",
    resolution: optionalString(record.type) ?? "",
    created: optionalString(record.created) ?? null,
    updated: optionalString(record.updated) ?? null,
    stats: record.stats ?? null,
  };
}

async function readJsonPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function mapBeszelError(status: number, payload: unknown, phase: "validate" | "execute"): ProviderRequestError {
  const body = optionalRecord(payload);
  const message = optionalString(body?.message) ?? `Beszel API request failed with status ${status}`;
  if (status === 401 || status === 403) return new ProviderRequestError(phase === "validate" ? 400 : 401, message);
  if (status === 404) return new ProviderRequestError(404, message);
  if (status === 429) return new ProviderRequestError(429, message);
  if (status === 400 || status === 422) return new ProviderRequestError(400, message);
  return new ProviderRequestError(502, message);
}

function boundedInteger(value: unknown, fieldName: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = optionalInteger(value);
  if (parsed === undefined || parsed < minimum || parsed > maximum) {
    throw new ProviderRequestError(400, `${fieldName} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function optionalPocketBaseDate(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  const text = requiredProviderString(value, fieldName);
  const date = new Date(text);
  if (Number.isNaN(date.valueOf())) throw new ProviderRequestError(400, `${fieldName} must be a valid date-time`);
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function pocketBaseQuoted(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function readNonNegativeInteger(value: unknown, fieldName: string): number {
  const result = optionalInteger(value);
  if (result === undefined || result < 0) {
    throw new ProviderRequestError(502, `Beszel returned an invalid ${fieldName}`);
  }
  return result;
}

function requiredProviderString(value: unknown, fieldName: string): string {
  return requiredString(value, fieldName, providerError);
}

function providerError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
