import { Link, data, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { getCurrentUserId } from "~/lib/session";
import {
  ANALYTICS_RANGES,
  getEnrollmentSeries,
  getInstructorOverview,
  getRevenueByCountry,
  getRevenueSeries,
  getRevenueSplit,
  parseAnalyticsRange,
  resolveAnalyticsInstructor,
  type AnalyticsRange,
} from "~/services/instructorAnalyticsService";
import { StatCard, formatCount, formatRevenue } from "~/components/analytics";
import {
  EnrollmentChart,
  RevenueByCountryTable,
  RevenueChart,
  RevenueSplitCard,
} from "~/components/analytics-charts";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import {
  AlertTriangle,
  BarChart3,
  DollarSign,
  GraduationCap,
  ShoppingCart,
  Users,
  UserPlus,
} from "lucide-react";

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export function meta() {
  return [
    { title: "Analytics — Cadence" },
    { name: "description", content: "Revenue, sales and enrollment analytics" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const range = parseAnalyticsRange(url.searchParams.get("range"));
  const requestedParam = url.searchParams.get("instructorId");
  const requestedInstructorId =
    requestedParam && /^\d+$/.test(requestedParam)
      ? Number(requestedParam)
      : null;

  const currentUserId = await getCurrentUserId(request);
  const access = resolveAnalyticsInstructor(
    currentUserId,
    requestedInstructorId
  );

  if (!access.ok) {
    switch (access.reason) {
      case "unauthenticated":
        throw data("Select a user from the DevUI panel to view analytics.", {
          status: 401,
        });
      case "forbidden":
        throw data("Only instructors and admins can view analytics.", {
          status: 403,
        });
      case "missing_instructor":
        throw data(
          "Choose an instructor from Manage Users to view their analytics.",
          { status: 400 }
        );
      case "not_found":
        throw data("Instructor not found.", { status: 404 });
    }
  }

  const { instructor } = access;
  const isViewingOther = instructor.id !== currentUserId;
  const overview = getInstructorOverview(instructor.id, range);

  return {
    range,
    overview,
    revenueSeries: getRevenueSeries(instructor.id, range),
    enrollmentSeries: getEnrollmentSeries(instructor.id, range),
    revenueByCountry: getRevenueByCountry(instructor.id, range),
    revenueSplit: getRevenueSplit(instructor.id, range),
    instructor,
    // Only carried in links when an admin is viewing someone else.
    instructorIdParam: isViewingOther ? instructor.id : null,
  };
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="mt-2 h-5 w-80" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const {
    range,
    overview,
    revenueSeries,
    enrollmentSeries,
    revenueByCountry,
    revenueSplit,
    instructor,
    instructorIdParam,
  } = loaderData;
  const { current, previous } = overview;

  function rangeHref(r: AnalyticsRange) {
    const params = new URLSearchParams({ range: r });
    if (instructorIdParam !== null) {
      params.set("instructorId", String(instructorIdParam));
    }
    return `?${params.toString()}`;
  }

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        {instructorIdParam !== null && (
          <>
            <Link to="/admin/users" className="hover:text-foreground">
              Manage Users
            </Link>
            <span className="mx-2">/</span>
          </>
        )}
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            {instructorIdParam !== null
              ? `Viewing ${instructor.name}'s courses`
              : "How your courses are performing"}
          </p>
        </div>

        {overview.hasCourses && (
          <div className="inline-flex rounded-md border border-border p-1">
            {ANALYTICS_RANGES.map((r) => (
              <Link
                key={r}
                to={rangeHref(r)}
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
        )}
      </div>

      {!overview.hasCourses ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">Publish your first course</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Analytics appear once you have a published course. Draft courses
            aren't included.
          </p>
          {instructorIdParam === null && (
            <Link to="/instructor" className="mt-4">
              <Button>
                <GraduationCap className="mr-2 size-4" />
                Go to My Courses
              </Button>
            </Link>
          )}
        </Card>
      ) : (
        <div className="space-y-6">
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

          <div className="grid gap-4 lg:grid-cols-2">
            <RevenueChart {...revenueSeries} />
            <EnrollmentChart {...enrollmentSeries} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <RevenueByCountryTable rows={revenueByCountry} />
            </div>
            <RevenueSplitCard {...revenueSplit} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else if (error.status === 404) {
      title = "Not found";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
