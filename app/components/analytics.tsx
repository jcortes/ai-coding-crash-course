import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";

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
