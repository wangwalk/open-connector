import type {
  PlausibleBreakdownDimension,
  PlausibleDimension,
  PlausibleFilterOperator,
  PlausibleMetric,
  PlausibleOrderDirection,
  PlausibleTimeDimension,
  PlausibleVolumeMetric,
} from "./fields.ts";

import { optionalNumber, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";
import {
  plausibleBreakdownDimensionNames,
  plausibleDateRangeNames,
  plausibleDimensionNames,
  plausibleFilterOperatorNames,
  plausibleMetricNames,
  plausibleOrderDirectionNames,
  plausibleOverviewMetrics,
  plausibleTimeDimensionNames,
  plausibleVolumeMetricNames,
} from "./fields.ts";

export const plausibleDefaultBaseUrl = "https://plausible.io";

const statsPath = "/api/v2/query";
const maxFilters = 10;
const maxFilterValues = 20;
const maxMetrics = 6;
const maxDimensions = 3;
const maxRows = 100;

const metricSet = new Set<string>(plausibleMetricNames);
const volumeMetricSet = new Set<string>(plausibleVolumeMetricNames);
const dimensionSet = new Set<string>(plausibleDimensionNames);
const breakdownDimensionSet = new Set<string>(plausibleBreakdownDimensionNames);
const timeDimensionSet = new Set<string>(plausibleTimeDimensionNames);
const filterOperatorSet = new Set<string>(plausibleFilterOperatorNames);
const dateRangeSet = new Set<string>(plausibleDateRangeNames);
const orderDirectionSet = new Set<string>(plausibleOrderDirectionNames);

interface PlausibleContext {
  apiKey: string;
  siteId?: string;
  baseUrl?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

interface PlausibleFilter {
  operator: PlausibleFilterOperator;
  dimension: PlausibleBreakdownDimension;
  values: string[];
  caseSensitive?: boolean;
}

interface PlausibleOrder {
  field: PlausibleMetric | PlausibleDimension;
  direction: PlausibleOrderDirection;
}

interface PlausibleStatsRequest {
  siteId: string;
  dateRange: PlausibleDateRange;
  metrics: PlausibleMetric[];
  dimensions: PlausibleDimension[];
  filters: PlausibleFilter[];
  orderBy: PlausibleOrder[];
  limit?: number;
  offset?: number;
  includeTimeLabels?: boolean;
  includeTotalRows?: boolean;
}

interface NormalizedStatsRow {
  dimensions: Record<string, string | number | null>;
  metrics: Record<string, number | null>;
}

interface NormalizedStatsResponse {
  site_id: string;
  date_range: PlausibleDateRange;
  metrics: PlausibleMetric[];
  dimensions: PlausibleDimension[];
  rows: NormalizedStatsRow[];
  total_rows: number | null;
  time_labels: string[];
  warnings: string[];
}

type PlausibleDateRange = string | [string, string];
type PlausibleHandler = (input: Record<string, unknown>, context: PlausibleContext) => Promise<unknown>;

export const plausibleAnalyticsActionHandlers: Record<string, PlausibleHandler> = {
  async query_stats(input, context) {
    return executeNormalizedStats(context, buildAdvancedRequest(input, context));
  },
  async get_overview(input, context) {
    return executeNormalizedStats(context, {
      ...buildSemanticBaseRequest(input, context),
      metrics: [...plausibleOverviewMetrics],
      dimensions: [],
      orderBy: [],
    });
  },
  async get_timeseries(input, context) {
    const interval = readAllowedString(input.interval, "interval", timeDimensionSet) as PlausibleTimeDimension;
    return executeNormalizedStats(context, {
      ...buildSemanticBaseRequest(input, context),
      metrics: readMetrics(input.metrics),
      dimensions: [interval],
      orderBy: [{ field: interval, direction: "asc" }],
      includeTimeLabels: true,
    });
  },
  async get_breakdown(input, context) {
    const metrics = readMetrics(input.metrics);
    const dimension = readBreakdownDimension(input.dimension, "dimension");
    return executeNormalizedStats(context, {
      ...buildSemanticBaseRequest(input, context),
      metrics,
      dimensions: [dimension],
      orderBy: [{ field: metrics[0]!, direction: "desc" }],
      limit: readBoundedInteger(input.limit, "limit", 25, 1, maxRows),
      offset: readBoundedInteger(input.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
      includeTotalRows: true,
    });
  },
  async compare_periods(input, context) {
    return comparePeriods(input, context);
  },
  async find_growth_opportunities(input, context) {
    return findGrowthOpportunities(input, context);
  },
};

export async function validatePlausibleAnalyticsCredential(
  apiKey: string,
  siteIdValue: string | undefined,
  baseUrlValue: string | undefined,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<{
  profile: { accountId: string; displayName: string };
  grantedScopes: string[];
  metadata: Record<string, unknown>;
}> {
  const siteId = normalizeRequiredSiteId(siteIdValue);
  const baseUrl = normalizePlausibleBaseUrl(baseUrlValue);
  await requestPlausibleStats(
    { apiKey, siteId, baseUrl, fetcher, signal },
    {
      siteId,
      dateRange: "7d",
      metrics: ["visitors"],
      dimensions: [],
      filters: [],
      orderBy: [],
      limit: 1,
    },
    "validate",
  );
  return {
    profile: { accountId: buildProviderAccountId(baseUrl, siteId), displayName: `Plausible ${siteId}` },
    grantedScopes: [],
    metadata: { baseUrl, siteId, validationEndpoint: statsPath },
  };
}

async function comparePeriods(input: Record<string, unknown>, context: PlausibleContext): Promise<unknown> {
  const siteId = resolveActionSiteId(input, context);
  const metrics = input.metrics === undefined ? [...plausibleOverviewMetrics] : readMetrics(input.metrics);
  const filters = readFilters(input.filters);
  const currentRequest: PlausibleStatsRequest = {
    siteId,
    dateRange: readDateRange(input.current_date_range, "current_date_range"),
    metrics,
    dimensions: [],
    filters,
    orderBy: [],
  };
  const comparisonRequest: PlausibleStatsRequest = {
    ...currentRequest,
    dateRange: readDateRange(input.comparison_date_range, "comparison_date_range"),
  };
  const [current, comparison] = await Promise.all([
    executeNormalizedStats(context, currentRequest),
    executeNormalizedStats(context, comparisonRequest),
  ]);
  return {
    site_id: siteId,
    current_date_range: current.date_range,
    comparison_date_range: comparison.date_range,
    comparisons: metrics.map((metric) => {
      const currentValue = metricFromFirstRow(current, metric);
      const comparisonValue = metricFromFirstRow(comparison, metric);
      const absoluteChange = subtractMetrics(currentValue, comparisonValue);
      return {
        metric,
        current: currentValue,
        comparison: comparisonValue,
        absolute_change: absoluteChange,
        percent_change: percentageChange(currentValue, comparisonValue),
      };
    }),
    warnings: uniqueStrings([...current.warnings, ...comparison.warnings]),
  };
}

async function findGrowthOpportunities(input: Record<string, unknown>, context: PlausibleContext): Promise<unknown> {
  const siteId = resolveActionSiteId(input, context);
  const metric = readAllowedString(input.metric, "metric", volumeMetricSet) as PlausibleVolumeMetric;
  const dimension = readBreakdownDimension(input.dimension, "dimension");
  const filters = readFilters(input.filters);
  const limit = readBoundedInteger(input.limit, "limit", 10, 1, 50);
  const baseRequest: Omit<PlausibleStatsRequest, "dateRange"> = {
    siteId,
    metrics: [metric],
    dimensions: [dimension],
    filters,
    orderBy: [{ field: metric, direction: "desc" }],
    limit: maxRows,
  };
  const currentRequest: PlausibleStatsRequest = {
    ...baseRequest,
    dateRange: readDateRange(input.current_date_range, "current_date_range"),
  };
  const comparisonRequest: PlausibleStatsRequest = {
    ...baseRequest,
    dateRange: readDateRange(input.comparison_date_range, "comparison_date_range"),
  };
  const [current, comparison] = await Promise.all([
    executeNormalizedStats(context, currentRequest),
    executeNormalizedStats(context, comparisonRequest),
  ]);
  const comparisonByValue = new Map<string, number>();
  for (const row of comparison.rows) {
    const dimensionValue = row.dimensions[dimension];
    const value = row.metrics[metric];
    if (dimensionValue !== null && typeof value === "number") {
      comparisonByValue.set(JSON.stringify(dimensionValue), value);
    }
  }
  const opportunities = current.rows
    .flatMap((row) => {
      const dimensionValue = row.dimensions[dimension];
      const currentValue = row.metrics[metric];
      if (dimensionValue === null || typeof currentValue !== "number") {
        return [];
      }
      const comparisonValue = comparisonByValue.get(JSON.stringify(dimensionValue)) ?? 0;
      const absoluteChange = currentValue - comparisonValue;
      if (absoluteChange <= 0) {
        return [];
      }
      return [
        {
          dimension_value: dimensionValue,
          current: currentValue,
          comparison: comparisonValue,
          absolute_change: absoluteChange,
          percent_change: percentageChange(currentValue, comparisonValue),
          status: comparisonValue === 0 ? "new" : "growing",
        },
      ];
    })
    .sort((left, right) => right.absolute_change - left.absolute_change || right.current - left.current)
    .slice(0, limit);
  return {
    site_id: siteId,
    metric,
    dimension,
    current_date_range: current.date_range,
    comparison_date_range: comparison.date_range,
    opportunities,
    warnings: uniqueStrings([...current.warnings, ...comparison.warnings]),
  };
}

function buildAdvancedRequest(input: Record<string, unknown>, context: PlausibleContext): PlausibleStatsRequest {
  const metrics = readMetrics(input.metrics);
  const dimensions = readOptionalDimensions(input.dimensions);
  const orderBy = readOrders(input.order_by, metrics, dimensions);
  const pagination = optionalRecord(input.pagination);
  return {
    siteId: resolveActionSiteId(input, context),
    dateRange: readDateRange(input.date_range, "date_range"),
    metrics,
    dimensions,
    filters: readFilters(input.filters),
    orderBy,
    limit: readBoundedInteger(pagination?.limit, "pagination.limit", maxRows, 1, maxRows),
    offset: readBoundedInteger(pagination?.offset, "pagination.offset", 0, 0, Number.MAX_SAFE_INTEGER),
    includeTimeLabels: input.include_time_labels === true,
    includeTotalRows: input.include_total_rows === true,
  };
}

function buildSemanticBaseRequest(
  input: Record<string, unknown>,
  context: PlausibleContext,
): Pick<PlausibleStatsRequest, "siteId" | "dateRange" | "filters"> {
  return {
    siteId: resolveActionSiteId(input, context),
    dateRange: readDateRange(input.date_range, "date_range"),
    filters: readFilters(input.filters),
  };
}

async function executeNormalizedStats(
  context: PlausibleContext,
  request: PlausibleStatsRequest,
): Promise<NormalizedStatsResponse> {
  const payload = await requestPlausibleStats(context, request, "execute");
  return normalizeStatsResponse(payload, request);
}

async function requestPlausibleStats(
  context: PlausibleContext,
  request: PlausibleStatsRequest,
  phase: "validate" | "execute",
): Promise<Record<string, unknown>> {
  const response = await requestPlausibleJson({
    context,
    path: statsPath,
    phase,
    body: statsRequestBody(request),
  });
  const record = optionalRecord(response);
  if (!record || !Array.isArray(record.results)) {
    throw new ProviderRequestError(502, "plausible stats response is missing results");
  }
  return record;
}

function statsRequestBody(request: PlausibleStatsRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    site_id: request.siteId,
    date_range: request.dateRange,
    metrics: request.metrics,
  };
  if (request.dimensions.length > 0) body.dimensions = request.dimensions;
  if (request.filters.length > 0) {
    body.filters = request.filters.map((filter) => {
      const base: unknown[] = [filter.operator, filter.dimension, filter.values];
      if (filter.caseSensitive !== undefined && (filter.operator === "is" || filter.operator === "contains")) {
        base.push({ case_sensitive: filter.caseSensitive });
      }
      return base;
    });
  }
  if (request.orderBy.length > 0) {
    body.order_by = request.orderBy.map((order) => [order.field, order.direction]);
  }
  if (request.includeTimeLabels || request.includeTotalRows) {
    body.include = {
      ...(request.includeTimeLabels ? { time_labels: true } : {}),
      ...(request.includeTotalRows ? { total_rows: true } : {}),
    };
  }
  if (request.limit !== undefined || request.offset !== undefined) {
    body.pagination = {
      limit: request.limit ?? maxRows,
      offset: request.offset ?? 0,
    };
  }
  return body;
}

function normalizeStatsResponse(
  payload: Record<string, unknown>,
  request: PlausibleStatsRequest,
): NormalizedStatsResponse {
  const query = optionalRecord(payload.query);
  const meta = optionalRecord(payload.meta);
  const resolvedDateRange = safeResolvedDateRange(query?.date_range, request.dateRange);
  const rows = (payload.results as unknown[]).map((value) => {
    const row = optionalRecord(value);
    const dimensionValues = Array.isArray(row?.dimensions) ? row.dimensions : [];
    const metricValues = Array.isArray(row?.metrics) ? row.metrics : [];
    return {
      dimensions: Object.fromEntries(
        request.dimensions.map((name, index) => [name, normalizeDimensionValue(dimensionValues[index])]),
      ),
      metrics: Object.fromEntries(
        request.metrics.map((name, index) => [name, optionalNumber(metricValues[index]) ?? null]),
      ),
    };
  });
  return {
    site_id: optionalString(query?.site_id) ?? request.siteId,
    date_range: resolvedDateRange,
    metrics: [...request.metrics],
    dimensions: [...request.dimensions],
    rows,
    total_rows: readOptionalInteger(meta?.total_rows),
    time_labels: readStringList(meta?.time_labels),
    warnings: collectWarnings(meta),
  };
}

async function requestPlausibleJson(input: {
  context: PlausibleContext;
  path: string;
  phase: "validate" | "execute";
  body: unknown;
}): Promise<unknown> {
  const headers = new Headers({
    Authorization: `Bearer ${input.context.apiKey}`,
    "Content-Type": "application/json",
  });
  let response: Response;
  try {
    response = await input.context.fetcher(
      buildPlausibleUrl(normalizePlausibleBaseUrl(input.context.baseUrl), input.path),
      {
        method: "POST",
        headers,
        body: JSON.stringify(input.body),
        signal: input.context.signal,
      },
    );
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `plausible request failed: ${error.message}` : "plausible request failed",
    );
  }
  const payload = await readPlausiblePayload(response);
  if (!response.ok) {
    throw createPlausibleError(response.status, payload, input.phase);
  }
  return payload;
}

async function readPlausiblePayload(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function createPlausibleError(status: number, payload: unknown, phase: "validate" | "execute"): ProviderRequestError {
  const record = optionalRecord(payload);
  const message =
    optionalString(record?.message) ??
    optionalString(record?.error) ??
    optionalString(record?.detail) ??
    `plausible request failed with ${status}`;
  if (status === 401 || status === 403) {
    return new ProviderRequestError(phase === "validate" ? 400 : status, message);
  }
  if (status === 429) return new ProviderRequestError(429, message);
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderRequestError(400, message);
  }
  return new ProviderRequestError(status >= 500 ? 502 : status, message);
}

function readMetrics(value: unknown): PlausibleMetric[] {
  return readAllowedStringArray(value, "metrics", metricSet, 1, maxMetrics) as PlausibleMetric[];
}

function readOptionalDimensions(value: unknown): PlausibleDimension[] {
  if (value === undefined) return [];
  return readAllowedStringArray(value, "dimensions", dimensionSet, 1, maxDimensions) as PlausibleDimension[];
}

function readFilters(value: unknown): PlausibleFilter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxFilters) {
    throw new ProviderRequestError(400, `filters must be an array with at most ${maxFilters} items`);
  }
  return value.map((item, index) => {
    const filter = optionalRecord(item);
    if (!filter) throw new ProviderRequestError(400, `filters[${index}] must be an object`);
    const operator = readAllowedString(
      filter.operator,
      `filters[${index}].operator`,
      filterOperatorSet,
    ) as PlausibleFilterOperator;
    const dimension = readBreakdownDimension(filter.dimension, `filters[${index}].dimension`);
    if (dimension === "event:goal" && operator !== "is" && operator !== "contains") {
      throw new ProviderRequestError(400, "event:goal filters support only is and contains operators");
    }
    return {
      operator,
      dimension,
      values: readFilterValues(filter.values, `filters[${index}].values`),
      caseSensitive: typeof filter.case_sensitive === "boolean" ? filter.case_sensitive : undefined,
    };
  });
}

function readOrders(value: unknown, metrics: PlausibleMetric[], dimensions: PlausibleDimension[]): PlausibleOrder[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new ProviderRequestError(400, "order_by must be an array with at most 3 items");
  }
  const requestedFields = new Set<string>([...metrics, ...dimensions]);
  return value.map((item, index) => {
    const order = optionalRecord(item);
    if (!order) throw new ProviderRequestError(400, `order_by[${index}] must be an object`);
    const field = requiredString(order.field, `order_by[${index}].field`);
    if (!requestedFields.has(field)) {
      throw new ProviderRequestError(400, `order_by[${index}].field must be a requested metric or dimension`);
    }
    const direction = readAllowedString(
      order.direction,
      `order_by[${index}].direction`,
      orderDirectionSet,
    ) as PlausibleOrderDirection;
    return { field: field as PlausibleMetric | PlausibleDimension, direction };
  });
}

function readDateRange(value: unknown, fieldName: string): PlausibleDateRange {
  if (typeof value === "string") {
    if (!dateRangeSet.has(value)) {
      throw new ProviderRequestError(400, `${fieldName} must be a supported relative range or ISO tuple`);
    }
    return value;
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ProviderRequestError(400, `${fieldName} must contain exactly two ISO boundaries`);
  }
  const from = requiredString(value[0], `${fieldName}[0]`);
  const to = requiredString(value[1], `${fieldName}[1]`);
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime > toTime) {
    throw new ProviderRequestError(400, `${fieldName} must be a valid ascending ISO date or date-time tuple`);
  }
  return [from, to];
}

function safeResolvedDateRange(value: unknown, fallback: PlausibleDateRange): PlausibleDateRange {
  try {
    return readDateRange(value, "response.query.date_range");
  } catch {
    return fallback;
  }
}

function readBreakdownDimension(value: unknown, fieldName: string): PlausibleBreakdownDimension {
  return readAllowedString(value, fieldName, breakdownDimensionSet) as PlausibleBreakdownDimension;
}

function readAllowedString(value: unknown, fieldName: string, allowed: Set<string>): string {
  const parsed = requiredString(value, fieldName);
  if (!allowed.has(parsed)) {
    throw new ProviderRequestError(400, `${fieldName} is not supported`);
  }
  return parsed;
}

function readAllowedStringArray(
  value: unknown,
  fieldName: string,
  allowed: Set<string>,
  minimum: number,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ProviderRequestError(400, `${fieldName} must contain between ${minimum} and ${maximum} items`);
  }
  const result = value.map((item, index) => readAllowedString(item, `${fieldName}[${index}]`, allowed));
  if (new Set(result).size !== result.length) {
    throw new ProviderRequestError(400, `${fieldName} must not contain duplicates`);
  }
  return result;
}

function readFilterValues(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxFilterValues) {
    throw new ProviderRequestError(400, `${fieldName} must contain between 1 and ${maxFilterValues} items`);
  }
  return value.map((item, index) => {
    const parsed = requiredString(item, `${fieldName}[${index}]`);
    if (parsed.length > 300) throw new ProviderRequestError(400, `${fieldName}[${index}] is too long`);
    return parsed;
  });
}

function readBoundedInteger(
  value: unknown,
  fieldName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProviderRequestError(400, `${fieldName} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function resolveActionSiteId(input: Record<string, unknown>, context: PlausibleContext): string {
  const directValue = optionalString(input.site_id);
  if (directValue) return directValue;
  if (context.siteId) return context.siteId;
  throw new ProviderRequestError(400, "site_id is required when the connection has no default siteId");
}

export function normalizePlausibleBaseUrl(value?: string): string {
  if (!value) return plausibleDefaultBaseUrl;
  const url = assertPublicHttpUrl(value, {
    fieldName: "baseUrl",
    createError: (message) => new ProviderRequestError(400, message),
  });
  if (url.protocol !== "https:") {
    throw new ProviderRequestError(400, "Base URL must use https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "Base URL must not include credentials, query parameters, or fragments");
  }
  let pathname = url.pathname;
  while (pathname.endsWith("/") && pathname.length > 1) pathname = pathname.slice(0, -1);
  return pathname === "/" ? url.origin : `${url.origin}${pathname}`;
}

function normalizeRequiredSiteId(value: unknown): string {
  const siteId = optionalString(value);
  if (!siteId) throw new ProviderRequestError(400, "Site ID is required");
  return siteId;
}

function normalizeDimensionValue(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function readOptionalInteger(value: unknown): number | null {
  const parsed = optionalNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : null;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

function collectWarnings(meta: Record<string, unknown> | undefined): string[] {
  if (!meta) return [];
  const warnings: string[] = [];
  const importsWarning = optionalString(meta.imports_warning);
  if (importsWarning) warnings.push(importsWarning);
  const metricWarnings = optionalRecord(meta.metric_warnings);
  if (metricWarnings) {
    for (const value of Object.values(metricWarnings)) {
      const warning = optionalString(optionalRecord(value)?.warning);
      if (warning) warnings.push(warning);
    }
  }
  return uniqueStrings(warnings);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function metricFromFirstRow(response: NormalizedStatsResponse, metric: PlausibleMetric): number | null {
  return response.rows[0]?.metrics[metric] ?? null;
}

function subtractMetrics(current: number | null, comparison: number | null): number | null {
  return current === null || comparison === null ? null : current - comparison;
}

function percentageChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null || comparison === 0) return null;
  return Math.round(((current - comparison) / comparison) * 10_000) / 100;
}

function buildPlausibleUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function buildProviderAccountId(baseUrl: string, siteId: string): string {
  return `plausible:${new URL(baseUrl).host}:${siteId}`;
}
