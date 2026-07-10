import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import {
  plausibleBreakdownDimensionNames,
  plausibleDateRangeNames,
  plausibleDimensionNames,
  plausibleFilterOperatorNames,
  plausibleMetricNames,
  plausibleOrderDirectionNames,
  plausibleTimeDimensionNames,
  plausibleVolumeMetricNames,
} from "./fields.ts";

const service = "plausible_analytics";

const dateRange = s.union(
  [
    s.stringEnum("A supported relative Plausible date range.", [...plausibleDateRangeNames]),
    s.array("A custom [from, to] ISO 8601 date or date-time tuple.", s.nonEmptyString("One ISO 8601 boundary."), {
      minItems: 2,
      maxItems: 2,
    }),
  ],
  { description: "A bounded relative range or custom [from, to] ISO 8601 tuple." },
);

const metric = s.stringEnum("A supported Plausible metric.", [...plausibleMetricNames]);
const metrics = s.array("One to six supported Plausible metrics.", metric, { minItems: 1, maxItems: 6 });
const volumeMetric = s.stringEnum("A count metric suitable for deterministic change ranking.", [
  ...plausibleVolumeMetricNames,
]);
const dimension = s.stringEnum("A supported Plausible breakdown dimension.", [...plausibleBreakdownDimensionNames]);
const dimensions = s.array(
  "Up to three supported Plausible grouping dimensions.",
  s.stringEnum([...plausibleDimensionNames]),
  {
    minItems: 1,
    maxItems: 3,
  },
);

const filter = s.object(
  "A bounded simple Plausible filter. Multiple filters are combined with AND.",
  {
    operator: s.stringEnum("The Plausible simple-filter operator.", [...plausibleFilterOperatorNames]),
    dimension: s.stringEnum("The event or visit dimension to filter.", [...plausibleBreakdownDimensionNames]),
    values: s.array(
      "One or more values matched with OR inside this filter.",
      s.string("One filter value.", {
        minLength: 1,
        maxLength: 300,
      }),
      { minItems: 1, maxItems: 20 },
    ),
    case_sensitive: s.boolean("Whether `is` and `contains` matching is case-sensitive."),
  },
  { optional: ["case_sensitive"] },
);
const filters = s.array("Up to ten simple filters combined with AND.", filter, { maxItems: 10 });

const order = s.object("One typed sort instruction.", {
  field: s.stringEnum("A requested metric or dimension used to sort results.", [
    ...plausibleMetricNames,
    ...plausibleDimensionNames,
  ]),
  direction: s.stringEnum("Sort direction.", [...plausibleOrderDirectionNames]),
});
const orderBy = s.array("Up to three typed sort instructions.", order, { maxItems: 3 });

const pagination = s.object(
  "Bounded pagination options.",
  {
    limit: s.positiveInteger("Maximum rows to return, capped at 100.", { maximum: 100 }),
    offset: s.nonNegativeInteger("Zero-based row offset."),
  },
  { optional: ["limit", "offset"] },
);

const dimensionValue = s.union([s.string(), s.number(), { type: "null" }]);
const metricValue = s.nullableNumber("A numeric metric value, or null when unavailable.");
const namedRow = s.requiredObject("One normalized result row with named dimensions and metrics.", {
  dimensions: s.record("Dimension names mapped to their values.", dimensionValue),
  metrics: s.record("Metric names mapped to numeric values.", metricValue),
});

const normalizedStatsResponse = s.requiredObject("A normalized, allowlisted Plausible Stats API response.", {
  site_id: s.nonEmptyString("The queried Plausible site identifier."),
  date_range: dateRange,
  metrics: s.array("Metrics in stable output order.", metric),
  dimensions: s.array("Dimensions in stable output order.", s.stringEnum([...plausibleDimensionNames])),
  rows: s.array("Named query result rows.", namedRow),
  total_rows: s.nullableInteger("Total matching rows when requested."),
  time_labels: s.stringArray("Complete reporting-timezone time labels when requested."),
  warnings: s.stringArray("Allowlisted provider warnings relevant to the query."),
});

const siteAndDateInput = {
  site_id: s.nonEmptyString(
    "Site identifier in Plausible. Omit it to use the default site configured on the connection.",
  ),
  date_range: dateRange,
  filters,
};

const comparisonMetric = s.requiredObject("One deterministic period-over-period metric comparison.", {
  metric,
  current: metricValue,
  comparison: metricValue,
  absolute_change: metricValue,
  percent_change: metricValue,
});

const opportunity = s.requiredObject("One ranked dimension value with positive count growth.", {
  dimension_value: dimensionValue,
  current: s.number("Current-period count."),
  comparison: s.number("Comparison-period count."),
  absolute_change: s.number("Current minus comparison count."),
  percent_change: s.nullableNumber("Percentage change, or null for a zero comparison baseline."),
  status: s.stringEnum("Whether this is a newly observed or growing value.", ["new", "growing"]),
});

export const plausibleAnalyticsActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "query_stats",
    description:
      "Run an advanced read-only Plausible Stats API v2 query with typed metrics, dimensions, filters, sorting, and bounded pagination.",
    followUpActions: [
      "plausible_analytics.get_overview",
      "plausible_analytics.get_breakdown",
      "plausible_analytics.get_timeseries",
    ],
    inputSchema: s.actionInput(
      {
        ...siteAndDateInput,
        metrics,
        dimensions,
        order_by: orderBy,
        pagination,
        include_time_labels: s.boolean("Include complete reporting-timezone labels for a time dimension."),
        include_total_rows: s.boolean("Include total row count metadata for pagination."),
      },
      ["date_range", "metrics"],
    ),
    outputSchema: normalizedStatsResponse,
  }),
  defineProviderAction(service, {
    name: "get_overview",
    description:
      "Get a normalized read-only overview of visitors, visits, pageviews, engagement, bounce rate, and visit duration.",
    followUpActions: [
      "plausible_analytics.get_timeseries",
      "plausible_analytics.get_breakdown",
      "plausible_analytics.compare_periods",
    ],
    inputSchema: s.actionInput(siteAndDateInput, ["date_range"]),
    outputSchema: normalizedStatsResponse,
  }),
  defineProviderAction(service, {
    name: "get_timeseries",
    description: "Get normalized Plausible metrics over time with complete time labels for reliable Agent analysis.",
    followUpActions: ["plausible_analytics.compare_periods", "plausible_analytics.get_breakdown"],
    inputSchema: s.actionInput(
      {
        ...siteAndDateInput,
        metrics,
        interval: s.stringEnum("Reporting-timezone interval used to group the series.", [
          ...plausibleTimeDimensionNames,
        ]),
      },
      ["date_range", "metrics", "interval"],
    ),
    outputSchema: normalizedStatsResponse,
  }),
  defineProviderAction(service, {
    name: "get_breakdown",
    description:
      "Get a normalized read-only breakdown by page, acquisition, campaign, geography, device, browser, OS, or goal.",
    followUpActions: ["plausible_analytics.find_growth_opportunities"],
    inputSchema: s.actionInput(
      {
        ...siteAndDateInput,
        metrics,
        dimension,
        limit: s.positiveInteger("Maximum rows to return, capped at 100.", { maximum: 100 }),
        offset: s.nonNegativeInteger("Zero-based row offset."),
      },
      ["date_range", "metrics", "dimension"],
    ),
    outputSchema: normalizedStatsResponse,
  }),
  defineProviderAction(service, {
    name: "compare_periods",
    description:
      "Compare normalized aggregate metrics across two explicit Plausible date ranges and calculate deterministic changes.",
    followUpActions: ["plausible_analytics.find_growth_opportunities"],
    inputSchema: s.actionInput(
      {
        site_id: siteAndDateInput.site_id,
        current_date_range: dateRange,
        comparison_date_range: dateRange,
        metrics,
        filters,
      },
      ["current_date_range", "comparison_date_range"],
    ),
    outputSchema: s.requiredObject("Period-over-period comparison without provider-native raw payloads.", {
      site_id: s.nonEmptyString("The queried Plausible site identifier."),
      current_date_range: dateRange,
      comparison_date_range: dateRange,
      comparisons: s.array("Metric changes in stable requested order.", comparisonMetric),
      warnings: s.stringArray("Allowlisted warnings from either query."),
    }),
  }),
  defineProviderAction(service, {
    name: "find_growth_opportunities",
    description:
      "Rank pages, sources, campaigns, countries, devices, or goals whose count metric grew between two explicit periods.",
    inputSchema: s.actionInput(
      {
        site_id: siteAndDateInput.site_id,
        current_date_range: dateRange,
        comparison_date_range: dateRange,
        metric: volumeMetric,
        dimension,
        filters,
        limit: s.positiveInteger("Maximum positive-growth opportunities to return, capped at 50.", { maximum: 50 }),
      },
      ["current_date_range", "comparison_date_range", "metric", "dimension"],
    ),
    outputSchema: s.requiredObject("Deterministically ranked positive-growth dimension values.", {
      site_id: s.nonEmptyString("The queried Plausible site identifier."),
      metric: volumeMetric,
      dimension,
      current_date_range: dateRange,
      comparison_date_range: dateRange,
      opportunities: s.array("Positive-growth values sorted by absolute change descending.", opportunity),
      warnings: s.stringArray("Allowlisted warnings from either query."),
    }),
  }),
];
