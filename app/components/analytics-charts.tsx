import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { CourseStatus } from "~/db/schema";
import { COUNTRIES } from "~/lib/ppp";
import {
  formatCount,
  formatPercent,
  formatRevenue,
} from "~/components/analytics";
import type {
  BucketSize,
  CompletionMetrics,
  getCourseBreakdown,
  getEnrollmentSeries,
  getRevenueByCountry,
  getRevenueSeries,
  getRevenueSplit,
} from "~/services/instructorAnalyticsService";

const BUCKET_DESCRIPTIONS: Record<BucketSize, string> = {
  day: "Per day",
  week: "Per week (starting Monday)",
  month: "Per month",
};

// Bucket keys are UTC dates ("YYYY-MM-DD"); format them in UTC too.
function formatBucket(bucket: string, size: BucketSize, long = false): string {
  const date = new Date(`${bucket}T00:00:00.000Z`);
  if (size === "month") {
    return date.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return size === "week" && long ? `Week of ${day}` : day;
}

function formatDollarsShort(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000)
    return `$${(dollars / 1000).toFixed(dollars >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(dollars)}`;
}

const revenueConfig = {
  revenue: { label: "Revenue", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function RevenueChart({
  bucketSize,
  points,
}: ReturnType<typeof getRevenueSeries>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue</CardTitle>
        <CardDescription>{BUCKET_DESCRIPTIONS[bucketSize]}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={revenueConfig} className="h-64 w-full">
          <BarChart data={points} margin={{ left: 4, right: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={(value: string) => formatBucket(value, bucketSize)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(value: number) => formatDollarsShort(value)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    formatBucket(
                      String(payload?.[0]?.payload?.bucket ?? ""),
                      bucketSize,
                      true
                    )
                  }
                  formatter={(value, _name, item) => (
                    <div className="flex w-full justify-between gap-4">
                      <span className="text-muted-foreground">Revenue</span>
                      <span className="font-mono font-medium">
                        {formatRevenue(Number(value))}
                        <span className="ml-2 text-muted-foreground">
                          ({formatCount(Number(item.payload.sales))} sales)
                        </span>
                      </span>
                    </div>
                  )}
                />
              }
            />
            <Bar dataKey="revenue" fill="var(--color-revenue)" radius={3} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const enrollmentConfig = {
  enrollments: { label: "Enrollments", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function EnrollmentChart({
  bucketSize,
  points,
}: ReturnType<typeof getEnrollmentSeries>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New enrollments</CardTitle>
        <CardDescription>{BUCKET_DESCRIPTIONS[bucketSize]}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={enrollmentConfig} className="h-64 w-full">
          <BarChart data={points} margin={{ left: 4, right: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={(value: string) => formatBucket(value, bucketSize)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={32}
              allowDecimals={false}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    formatBucket(
                      String(payload?.[0]?.payload?.bucket ?? ""),
                      bucketSize,
                      true
                    )
                  }
                />
              }
            />
            <Bar
              dataKey="enrollments"
              fill="var(--color-enrollments)"
              radius={3}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

export function RevenueByCountryTable({
  rows,
}: {
  rows: ReturnType<typeof getRevenueByCountry>;
}) {
  const totalDiscount = rows.reduce((sum, r) => sum + r.discount, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by country</CardTitle>
        <CardDescription>
          PPP discount given: {formatRevenue(totalDiscount)} (list price × seats
          − amount paid)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No sales in this period.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Country</TableHead>
                <TableHead>PPP tier</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Discount given</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.country ?? "unknown"}>
                  <TableCell>
                    {row.country
                      ? (COUNTRY_NAMES.get(row.country) ?? row.country)
                      : "Unknown"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    Tier {row.tier} · {row.tierLabel}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCount(row.sales)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatRevenue(row.revenue)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatRevenue(row.discount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function RevenueSplitCard({
  individual,
  team,
}: ReturnType<typeof getRevenueSplit>) {
  const total = individual.revenue + team.revenue;
  const share = (part: number) => (total === 0 ? 0 : (part / total) * 100);
  const parts = [
    { label: "Individual", color: "var(--chart-1)", data: individual },
    { label: "Team", color: "var(--chart-2)", data: team },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Individual vs. team</CardTitle>
        <CardDescription>Total {formatRevenue(total)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {parts.map((p) => (
            <div
              key={p.label}
              style={{
                width: `${share(p.data.revenue)}%`,
                background: p.color,
              }}
            />
          ))}
        </div>
        <div className="space-y-4">
          {parts.map((p) => (
            <div
              key={p.label}
              className="flex items-start justify-between gap-4"
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-2.5 rounded-sm"
                  style={{ background: p.color }}
                />
                <div>
                  <div className="text-sm font-medium">{p.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatCount(p.data.sales)}{" "}
                    {p.data.sales === 1 ? "sale" : "sales"} ·{" "}
                    {formatCount(p.data.seats)}{" "}
                    {p.data.seats === 1 ? "seat" : "seats"}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium">
                  {formatRevenue(p.data.revenue)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {Math.round(share(p.data.revenue))}%
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function CompletionCard({
  enrolledStudents,
  completionRate,
  averageCompletion,
}: CompletionMetrics) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Completion</CardTitle>
        <CardDescription>
          All time · {formatCount(enrolledStudents)}{" "}
          {enrolledStudents === 1 ? "enrollment" : "enrollments"} (not affected
          by the date range)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="text-2xl font-bold">
            {formatPercent(completionRate)}
          </div>
          <p className="text-sm text-muted-foreground">
            finished every lesson
          </p>
        </div>
        <div>
          <div className="text-2xl font-bold">
            {formatPercent(averageCompletion)}
          </div>
          <p className="text-sm text-muted-foreground">
            average share of lessons completed
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function CourseBreakdownTable({
  rows,
}: {
  rows: ReturnType<typeof getCourseBreakdown>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Courses</CardTitle>
        <CardDescription>
          Revenue and sales for the selected period; students and completion
          are all time
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Course</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Students</TableHead>
              <TableHead className="text-right">Finished</TableHead>
              <TableHead className="text-right">Avg. completed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.courseId}>
                <TableCell className="font-medium">
                  {row.title}
                  {row.status === CourseStatus.Archived && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Archived
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {formatRevenue(row.revenue)}
                </TableCell>
                <TableCell className="text-right">
                  {formatCount(row.sales)}
                </TableCell>
                <TableCell className="text-right">
                  {formatCount(row.enrolledStudents)}
                </TableCell>
                <TableCell className="text-right">
                  {formatPercent(row.completionRate)}
                </TableCell>
                <TableCell className="text-right">
                  {formatPercent(row.averageCompletion)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
