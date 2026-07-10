import type { CredentialValidationResult } from "../../core/types.ts";
import type { DokployActionName } from "./actions.ts";

import { optionalInteger, optionalRecord, optionalString, requiredRecord, requiredString } from "../../core/cast.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

const requestTimeoutMs = 30_000;
const serviceKinds = ["application", "compose", "postgres", "mysql", "mariadb", "mongo", "redis"] as const;
type ServiceKind = (typeof serviceKinds)[number];

export interface DokployContext {
  apiBaseUrl: string;
  apiKey: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

type DokployActionHandler = (input: Record<string, unknown>, context: DokployContext) => Promise<unknown>;

export const dokployActionHandlers: Record<DokployActionName, DokployActionHandler> = {
  async list_projects(_input, context) {
    const payload = await requestDokployJson(context, "/project.all");
    return { projects: readArrayPayload(payload, ["projects", "data", "items"]).map(normalizeProject) };
  },
  async get_project(input, context) {
    const projectId = requiredProviderString(input.projectId, "projectId");
    const payload = requiredRecord(
      await requestDokployJson(context, "/project.one", { projectId }),
      "Dokploy project response",
      providerError,
    );
    return { project: normalizeProject(payload) };
  },
  async list_applications(input, context) {
    const query = {
      q: optionalString(input.query),
      projectId: optionalString(input.projectId),
      environmentId: optionalString(input.environmentId),
      limit: boundedInteger(input.limit, "limit", 1, 100, 20),
      offset: boundedInteger(input.offset, "offset", 0, 1_000_000, 0),
    };
    try {
      const payload = await requestDokployJson(context, "/application.search", query);
      const records = readArrayPayload(payload, ["applications", "data", "items"]);
      return { applications: records.map(normalizeApplication), total: readTotal(payload, records.length) };
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 404) throw error;
      const records = await readApplicationsFromProjectGraph(context, query.projectId, query.environmentId);
      const start = query.offset;
      const applications = records.slice(start, start + query.limit).map(normalizeApplication);
      return { applications, total: records.length };
    }
  },
  async list_services(input, context) {
    const projectId = optionalString(input.projectId);
    const environmentId = optionalString(input.environmentId);
    const kindInput = optionalString(input.type);
    if (kindInput && !serviceKinds.includes(kindInput as ServiceKind)) {
      throw new ProviderRequestError(400, "type is not a supported Dokploy service kind");
    }
    const payload = await requestDokployJson(context, "/project.all");
    const services = collectProjectServices(
      readArrayPayload(payload, ["projects", "data", "items"]).filter(
        (project) => !projectId || resourceId(project, "project") === projectId,
      ),
      environmentId,
    )
      .filter((entry) => !kindInput || entry.kind === kindInput)
      .map((entry) => normalizeService(entry.record, entry.kind, entry.projectId, entry.environmentId));
    return { services };
  },
  async get_application(input, context) {
    const applicationId = requiredProviderString(input.applicationId, "applicationId");
    const payload = requiredRecord(
      await requestDokployJson(context, "/application.one", { applicationId }),
      "Dokploy application response",
      providerError,
    );
    return { application: normalizeApplication(payload) };
  },
  async get_deployments(input, context) {
    const resourceIdInput = requiredProviderString(input.resourceId, "resourceId");
    const type = optionalString(input.type) ?? "application";
    const payload = await requestDokployJson(context, "/deployment.allByType", {
      id: resourceIdInput,
      type,
    });
    return { deployments: readArrayPayload(payload, ["deployments", "data", "items"]).map(normalizeDeployment) };
  },
  async get_application_status(input, context) {
    const applicationId = requiredProviderString(input.applicationId, "applicationId");
    const payload = requiredRecord(
      await requestDokployJson(context, "/application.one", { applicationId }),
      "Dokploy application response",
      providerError,
    );
    const application = normalizeApplication(payload);
    const appName = optionalString(payload.appName);
    if (!appName) return { application, containers: [] };
    const server = optionalRecord(payload.server);
    const serverId = optionalString(payload.serverId) ?? optionalString(server?.serverId) ?? optionalString(server?.id);
    const configuredType = optionalString(payload.serverType) ?? optionalString(server?.serverType);
    const type = configuredType === "swarm" ? "swarm" : "standalone";
    const containersPayload = await requestDokployJson(context, "/docker.getContainersByAppLabel", {
      appName,
      serverId,
      type,
    });
    return {
      application,
      containers: readArrayPayload(containersPayload, ["containers", "data", "items"]).map(normalizeContainer),
    };
  },
};

export async function validateDokployCredential(
  apiBaseUrlInput: unknown,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const apiBaseUrl = normalizeDokployApiBaseUrl(apiBaseUrlInput);
  const payload = await requestDokployJson({ apiBaseUrl, apiKey, fetcher, signal }, "/project.all");
  const projectCount = readArrayPayload(payload, ["projects", "data", "items"]).length;
  return {
    profile: {
      accountId: new URL(apiBaseUrl).host,
      displayName: `Dokploy at ${new URL(apiBaseUrl).host}`,
    },
    grantedScopes: [],
    metadata: {
      apiBaseUrl,
      validationEndpoint: "/project.all",
      projectCount,
    },
  };
}

export function normalizeDokployApiBaseUrl(value: unknown): string {
  const raw = requiredString(value, "apiBaseUrl", providerError);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRequestError(400, "Dokploy API URL must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRequestError(400, "Dokploy API URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "Dokploy API URL must not include credentials, query parameters, or fragments");
  }
  const trimmedPath = url.pathname.replace(/\/+$/u, "");
  url.pathname = trimmedPath.endsWith("/api") ? trimmedPath : `${trimmedPath}/api`.replace(/^\/+/u, "/");
  return url.toString().replace(/\/$/u, "");
}

async function requestDokployJson(
  context: DokployContext,
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<unknown> {
  const url = new URL(path.replace(/^\/+/, ""), `${context.apiBaseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const timeoutSignal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(requestTimeoutMs)])
    : AbortSignal.timeout(requestTimeoutMs);
  let response: Response;
  try {
    response = await context.fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": providerUserAgent,
        "x-api-key": context.apiKey,
      },
      signal: timeoutSignal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new ProviderRequestError(504, "Dokploy request timed out", error);
    }
    throw new ProviderRequestError(502, "Dokploy request failed", error);
  }
  const payload = await readJsonPayload(response);
  if (!response.ok) throw mapDokployError(response.status, payload);
  return payload;
}

interface ServiceEntry {
  kind: ServiceKind;
  record: Record<string, unknown>;
  projectId: string | undefined;
  environmentId: string | undefined;
}

function collectProjectServices(projects: Array<Record<string, unknown>>, environmentFilter?: string): ServiceEntry[] {
  const services: ServiceEntry[] = [];
  for (const project of projects) {
    const projectId = resourceId(project, "project") || undefined;
    for (const environment of recordArray(project.environments)) {
      const environmentId = resourceId(environment, "environment") || undefined;
      if (environmentFilter && environmentId !== environmentFilter) continue;
      for (const kind of serviceKinds) {
        for (const record of serviceRecords(environment, kind)) {
          services.push({ kind, record, projectId, environmentId });
        }
      }
    }
  }
  return services;
}

async function readApplicationsFromProjectGraph(
  context: DokployContext,
  projectFilter?: string,
  environmentFilter?: string,
): Promise<Array<Record<string, unknown>>> {
  const payload = await requestDokployJson(context, "/project.all");
  return collectProjectServices(readArrayPayload(payload, ["projects", "data", "items"]), environmentFilter)
    .filter((entry) => entry.kind === "application" && (!projectFilter || entry.projectId === projectFilter))
    .map((entry) => ({ ...entry.record, projectId: entry.projectId, environmentId: entry.environmentId }));
}

function serviceRecords(environment: Record<string, unknown>, kind: ServiceKind): Array<Record<string, unknown>> {
  const aliases: Record<ServiceKind, string[]> = {
    application: ["applications"],
    compose: ["compose", "composes"],
    postgres: ["postgres", "postgreses"],
    mysql: ["mysql", "mysqls"],
    mariadb: ["mariadb", "mariadbs"],
    mongo: ["mongo", "mongos"],
    redis: ["redis", "redises"],
  };
  for (const key of aliases[kind]) {
    if (Array.isArray(environment[key])) return recordArray(environment[key]);
  }
  return [];
}

function normalizeProject(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: resourceId(record, "project"),
    name: resourceName(record, "project"),
    description: optionalString(record.description) ?? null,
    createdAt: optionalString(record.createdAt) ?? null,
    updatedAt: optionalString(record.updatedAt) ?? null,
    environments: recordArray(record.environments).map((environment) => ({
      id: resourceId(environment, "environment"),
      name: resourceName(environment, "environment"),
      description: optionalString(environment.description) ?? null,
      createdAt: optionalString(environment.createdAt) ?? null,
    })),
  };
}

function normalizeApplication(record: Record<string, unknown>): Record<string, unknown> {
  const source = optionalRecord(record.source);
  return {
    id: resourceId(record, "application"),
    name: resourceName(record, "application"),
    appName: optionalString(record.appName) ?? null,
    description: optionalString(record.description) ?? null,
    status: optionalString(record.applicationStatus) ?? optionalString(record.status) ?? null,
    sourceType: optionalString(record.sourceType) ?? optionalString(record.buildType) ?? null,
    repository: optionalString(record.repository) ?? optionalString(source?.repository) ?? null,
    branch: optionalString(record.branch) ?? optionalString(source?.branch) ?? null,
    dockerImage: optionalString(record.dockerImage) ?? null,
    projectId: optionalString(record.projectId) ?? null,
    environmentId: optionalString(record.environmentId) ?? null,
    serverId: optionalString(record.serverId) ?? null,
    createdAt: optionalString(record.createdAt) ?? null,
    updatedAt: optionalString(record.updatedAt) ?? null,
  };
}

function normalizeService(
  record: Record<string, unknown>,
  kind: ServiceKind,
  projectId: string | undefined,
  environmentId: string | undefined,
): Record<string, unknown> {
  return {
    id: resourceId(record, kind),
    type: kind,
    name: resourceName(record, kind),
    appName: optionalString(record.appName) ?? null,
    status:
      optionalString(record.applicationStatus) ??
      optionalString(record.composeStatus) ??
      optionalString(record.status) ??
      null,
    projectId: optionalString(record.projectId) ?? projectId ?? null,
    environmentId: optionalString(record.environmentId) ?? environmentId ?? null,
    serverId: optionalString(record.serverId) ?? null,
    createdAt: optionalString(record.createdAt) ?? null,
    updatedAt: optionalString(record.updatedAt) ?? null,
  };
}

function normalizeDeployment(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: resourceId(record, "deployment"),
    title: optionalString(record.title) ?? null,
    description: optionalString(record.description) ?? null,
    status: optionalString(record.status) ?? optionalString(record.deploymentStatus) ?? null,
    source: optionalString(record.source) ?? null,
    createdAt: optionalString(record.createdAt) ?? null,
    startedAt: optionalString(record.startedAt) ?? null,
    finishedAt: optionalString(record.finishedAt) ?? optionalString(record.completedAt) ?? null,
  };
}

function normalizeContainer(record: Record<string, unknown>): Record<string, unknown> {
  const names = Array.isArray(record.Names) ? record.Names : [];
  const state = optionalRecord(record.State);
  return {
    id: optionalString(record.Id) ?? optionalString(record.ID) ?? optionalString(record.id) ?? "",
    name:
      optionalString(record.Name) ?? optionalString(record.name) ?? optionalString(names[0])?.replace(/^\//u, "") ?? "",
    image: optionalString(record.Image) ?? optionalString(record.image) ?? null,
    state: optionalString(record.State) ?? optionalString(record.state) ?? optionalString(state?.Status) ?? null,
    status: optionalString(record.Status) ?? optionalString(record.status) ?? null,
    health: optionalString(record.Health) ?? optionalString(record.health) ?? optionalString(state?.Health) ?? null,
    createdAt:
      optionalString(record.CreatedAt) ??
      optionalString(record.createdAt) ??
      (typeof record.Created === "number" ? new Date(record.Created * 1000).toISOString() : null),
  };
}

function readArrayPayload(payload: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.map((item) => requiredRecord(item, "Dokploy list item", providerError));
  const record = optionalRecord(payload);
  for (const key of keys) {
    if (Array.isArray(record?.[key])) return recordArray(record?.[key]);
  }
  return [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => requiredRecord(item, "Dokploy list item", providerError));
}

function readTotal(payload: unknown, fallback: number): number {
  const record = optionalRecord(payload);
  const value = optionalInteger(record?.total) ?? optionalInteger(record?.count) ?? optionalInteger(record?.totalItems);
  return value !== undefined && value >= 0 ? value : fallback;
}

function resourceId(record: Record<string, unknown>, kind: string): string {
  return optionalString(record[`${kind}Id`]) ?? optionalString(record.id) ?? "";
}

function resourceName(record: Record<string, unknown>, kind: string): string {
  return optionalString(record.name) ?? optionalString(record[`${kind}Name`]) ?? optionalString(record.appName) ?? "";
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

function mapDokployError(status: number, payload: unknown): ProviderRequestError {
  const body = optionalRecord(payload);
  const message =
    optionalString(body?.message) ??
    optionalString(optionalRecord(body?.error)?.message) ??
    `Dokploy API request failed with status ${status}`;
  if (status === 401 || status === 403) return new ProviderRequestError(401, message);
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

function requiredProviderString(value: unknown, fieldName: string): string {
  return requiredString(value, fieldName, providerError);
}

function providerError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
