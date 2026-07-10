import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "beszel";
const systemIdSchema = s.nonEmptyString("Beszel system record ID.");
const pageSchema = s.positiveInteger("One-based result page.");
const pageSizeSchema = s.integer("Number of records per page.", { minimum: 1, maximum: 100 });

const systemSchema = s.requiredObject("Safe Beszel system summary.", {
  id: s.string("System record ID."),
  name: s.string("System name."),
  status: s.nullableString("Current system status."),
  host: s.nullableString("Configured host."),
  port: s.nullableString("Configured agent port."),
  created: s.nullableString("Record creation timestamp."),
  updated: s.nullableString("Last record update timestamp."),
  info: s.looseObject("Allowlisted, non-credential system information."),
});

const containerSchema = s.requiredObject("Safe Beszel container summary.", {
  id: s.string("Container record ID."),
  systemId: s.string("Owning system record ID."),
  name: s.nullableString("Container name."),
  status: s.nullableString("Container status."),
  health: s.nullableNumber("Container health value reported by Beszel."),
  cpu: s.nullableNumber("Current container CPU percentage."),
  memory: s.nullableNumber("Current container memory usage."),
  network: s.nullableNumber("Current container network value."),
  image: s.nullableString("Container image."),
  ports: s.nullableString("Published port summary."),
  updated: s.nullableNumber("Beszel container update timestamp."),
});

const metricPointSchema = s.requiredObject("Beszel monitoring data point.", {
  id: s.string("Metric record ID."),
  systemId: s.string("Owning system record ID."),
  resolution: s.string("Beszel aggregation resolution."),
  created: s.nullableString("Metric creation timestamp."),
  updated: s.nullableString("Metric update timestamp."),
  stats: s.unknown("Provider-native metric payload. This collection contains monitoring values, not credentials."),
});

export const beszelActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_systems",
    description: "List Beszel systems available to the configured user without modifying them.",
    inputSchema: s.actionInput(
      {
        status: s.stringEnum("Optional status filter.", ["up", "down", "paused", "pending"]),
        page: pageSchema,
        pageSize: pageSizeSchema,
      },
      [],
      "Optional status and pagination filters.",
    ),
    outputSchema: s.actionOutput({
      systems: s.array("Beszel systems.", systemSchema),
      page: s.positiveInteger("Current page."),
      pageSize: s.positiveInteger("Current page size."),
      totalItems: s.nonNegativeInteger("Total matching systems."),
      totalPages: s.nonNegativeInteger("Total pages."),
    }),
  }),
  defineProviderAction(service, {
    name: "get_system",
    description: "Get one Beszel system by record ID without modifying it.",
    inputSchema: s.actionInput({ systemId: systemIdSchema }, ["systemId"]),
    outputSchema: s.actionOutput({ system: systemSchema }),
  }),
  defineProviderAction(service, {
    name: "list_containers",
    description: "List current Beszel container records for a system.",
    inputSchema: s.actionInput(
      {
        systemId: systemIdSchema,
        page: pageSchema,
        pageSize: pageSizeSchema,
      },
      ["systemId"],
    ),
    outputSchema: s.actionOutput({
      containers: s.array("Beszel containers.", containerSchema),
      page: s.positiveInteger("Current page."),
      pageSize: s.positiveInteger("Current page size."),
      totalItems: s.nonNegativeInteger("Total matching containers."),
      totalPages: s.nonNegativeInteger("Total pages."),
    }),
  }),
  defineProviderAction(service, {
    name: "get_metrics",
    description: "Read bounded Beszel system or container metric records for one system.",
    inputSchema: s.actionInput(
      {
        systemId: systemIdSchema,
        kind: s.stringEnum("Metric collection to query.", ["system", "container"]),
        resolution: s.stringEnum("Beszel aggregation resolution.", ["1m", "10m", "20m", "120m", "480m"]),
        startAt: s.dateTime("Optional inclusive UTC start timestamp."),
        endAt: s.dateTime("Optional inclusive UTC end timestamp."),
        maxPoints: s.integer("Maximum number of metric records.", { minimum: 1, maximum: 500 }),
      },
      ["systemId", "kind", "resolution"],
    ),
    outputSchema: s.actionOutput({
      kind: s.stringEnum("Metric collection queried.", ["system", "container"]),
      systemId: s.string("Owning system record ID."),
      resolution: s.string("Beszel aggregation resolution."),
      points: s.array("Metric records in ascending time order.", metricPointSchema),
      totalItems: s.nonNegativeInteger("Total records matching the bounded query."),
    }),
  }),
];

export type BeszelActionName = (typeof beszelActions)[number]["name"];
