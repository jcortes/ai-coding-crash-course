import { Link } from "react-router";
import {
  ArrowDownRight,
  ArrowUpRight,
  DollarSign,
  Minus,
  ShoppingCart,
  UserPlus,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import { ANALYTICS_RANGES, type AnalyticsRange } from "~/lib/analytics-range";
import type { getInstructorOverview } from "~/services/instructorAnalyticsService";

/** Formats USD cents as "$1,234.56" (0 renders as "$0.00", not "Free"). */
export function formatRevenue(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Formats a 0–1 share as "42%"; null (nothing to measure) renders as "—". */
export function formatPercent(share: number | null): string {
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}

export function ChangeIndicator({
  current,
  previous,
}: {
  current: number;
  previous: number;
}) {
  if (current === previous) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="size-3" />
        No change
      </span>
    );
  }

  const isUp = current > previous;
  const label =
    previous === 0
      ? "New"
      : `${Math.abs(Math.round(((current - previous) / previous) * 100))}%`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        isUp
          ? "text-green-700 dark:text-green-400"
          : "text-red-700 dark:text-red-400"
      )}
    >
      {isUp ? (
        <ArrowUpRight className="size-3" />
      ) : (
        <ArrowDownRight className="size-3" />
      )}
      {label}
      <span className="font-normal text-muted-foreground">vs previous period</span>
    </span>
  );
}

export function StatCard({
  title,
  value,
  current,
  previous,
  icon,
}: {
  title: string;
  value: string;
  current: number;
  previous: number | null;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="gap-2">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <div className="mt-1 h-4">
          {previous !== null && (
            <ChangeIndicator current={current} previous={previous} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export function RangePicker({
  range,
  hrefFor,
}: {
  range: AnalyticsRange;
  hrefFor: (range: AnalyticsRange) => string;
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-1">
      {ANALYTICS_RANGES.map((r) => (
        <Link
          key={r}
          to={hrefFor(r)}
          preventScrollReset
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            r === range
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {RANGE_LABELS[r]}
        </Link>
      ))}
    </div>
  );
}

type Overview = ReturnType<typeof getInstructorOverview>;

/** Revenue, sales, seats and new enrollments, each vs the previous period. */
export function HeadlineCards({
  current,
  previous,
}: Pick<Overview, "current" | "previous">) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Revenue"
        value={formatRevenue(current.revenue)}
        current={current.revenue}
        previous={previous?.revenue ?? null}
        icon={<DollarSign className="size-4" />}
      />
      <StatCard
        title="Sales"
        value={formatCount(current.sales)}
        current={current.sales}
        previous={previous?.sales ?? null}
        icon={<ShoppingCart className="size-4" />}
      />
      <StatCard
        title="Seats"
        value={formatCount(current.seats)}
        current={current.seats}
        previous={previous?.seats ?? null}
        icon={<Users className="size-4" />}
      />
      <StatCard
        title="New enrollments"
        value={formatCount(current.newEnrollments)}
        current={current.newEnrollments}
        previous={previous?.newEnrollments ?? null}
        icon={<UserPlus className="size-4" />}
      />
    </div>
  );
}
