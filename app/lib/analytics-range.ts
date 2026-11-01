// Analytics date-range constants. Kept out of instructorAnalyticsService so
// client components can import them without pulling `~/db` (and better-sqlite3)
// into the browser bundle.

export type AnalyticsRange = "7d" | "30d" | "90d" | "all";

export const ANALYTICS_RANGES: AnalyticsRange[] = ["7d", "30d", "90d", "all"];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = "30d";

export function parseAnalyticsRange(value: string | null): AnalyticsRange {
  return ANALYTICS_RANGES.find((r) => r === value) ?? DEFAULT_ANALYTICS_RANGE;
}
