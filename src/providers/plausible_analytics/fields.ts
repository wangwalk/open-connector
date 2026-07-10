export const plausibleMetricNames = [
  "visitors",
  "visits",
  "pageviews",
  "views_per_visit",
  "bounce_rate",
  "visit_duration",
  "events",
  "percentage",
  "conversion_rate",
  "group_conversion_rate",
  "time_on_page",
] as const;

export type PlausibleMetric = (typeof plausibleMetricNames)[number];

export const plausibleVolumeMetricNames = ["visitors", "visits", "pageviews", "events"] as const;

export type PlausibleVolumeMetric = (typeof plausibleVolumeMetricNames)[number];

export const plausibleBreakdownDimensionNames = [
  "event:goal",
  "event:page",
  "event:hostname",
  "visit:entry_page",
  "visit:entry_page_hostname",
  "visit:exit_page",
  "visit:exit_page_hostname",
  "visit:source",
  "visit:referrer",
  "visit:channel",
  "visit:utm_medium",
  "visit:utm_source",
  "visit:utm_campaign",
  "visit:utm_content",
  "visit:utm_term",
  "visit:device",
  "visit:browser",
  "visit:browser_version",
  "visit:os",
  "visit:os_version",
  "visit:country",
  "visit:region",
  "visit:city",
  "visit:country_name",
  "visit:region_name",
  "visit:city_name",
] as const;

export type PlausibleBreakdownDimension = (typeof plausibleBreakdownDimensionNames)[number];

export const plausibleTimeDimensionNames = ["time", "time:hour", "time:day", "time:week", "time:month"] as const;

export type PlausibleTimeDimension = (typeof plausibleTimeDimensionNames)[number];

export type PlausibleDimension = PlausibleBreakdownDimension | PlausibleTimeDimension;

export const plausibleDimensionNames: readonly PlausibleDimension[] = [
  ...plausibleBreakdownDimensionNames,
  ...plausibleTimeDimensionNames,
];

export const plausibleFilterOperatorNames = [
  "is",
  "is_not",
  "contains",
  "contains_not",
  "matches",
  "matches_not",
] as const;

export type PlausibleFilterOperator = (typeof plausibleFilterOperatorNames)[number];

export const plausibleDateRangeNames = [
  "day",
  "24h",
  "7d",
  "28d",
  "30d",
  "91d",
  "month",
  "6mo",
  "12mo",
  "year",
  "all",
] as const;

export type PlausibleNamedDateRange = (typeof plausibleDateRangeNames)[number];

export const plausibleOrderDirectionNames = ["asc", "desc"] as const;

export type PlausibleOrderDirection = (typeof plausibleOrderDirectionNames)[number];

export const plausibleOverviewMetrics: PlausibleMetric[] = [
  "visitors",
  "visits",
  "pageviews",
  "views_per_visit",
  "bounce_rate",
  "visit_duration",
];
