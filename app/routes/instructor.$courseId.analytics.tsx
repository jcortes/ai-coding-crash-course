import { Link, data, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { getCurrentUserId } from "~/lib/session";
import {
  getEnrollmentSeries,
  getInstructorOverview,
  getLessonFunnel,
  getRevenueByCountry,
  getRevenueSeries,
  getRevenueSplit,
  parseAnalyticsRange,
  resolveCourseAnalyticsAccess,
  type AnalyticsRange,
} from "~/services/instructorAnalyticsService";
import { HeadlineCards, RangePicker } from "~/components/analytics";
import {
  CompletionCard,
  EnrollmentChart,
  LessonFunnel,
  RevenueByCountryTable,
  RevenueChart,
  RevenueSplitCard,
} from "~/components/analytics-charts";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { AlertTriangle, BarChart3, Users } from "lucide-react";

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course.title ?? "Course";
  return [
    { title: `Analytics: ${title} — Cadence` },
    { name: "description", content: `Analytics and lesson drop-off for ${title}` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const range = parseAnalyticsRange(url.searchParams.get("range"));

  if (!/^\d+$/.test(params.courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }
  const courseId = Number(params.courseId);

  const currentUserId = await getCurrentUserId(request);
  const access = resolveCourseAnalyticsAccess(currentUserId, courseId);

  if (!access.ok) {
    switch (access.reason) {
      case "unauthenticated":
        throw data("Select a user from the DevUI panel to view analytics.", {
          status: 401,
        });
      case "forbidden":
        throw data("You can only view analytics for your own courses.", {
          status: 403,
        });
      case "not_found":
        throw data("Course not found.", { status: 404 });
    }
  }

  const { course, instructor, viewerIsAdmin } = access;
  const overview = getInstructorOverview(instructor.id, range, course.id);

  return {
    range,
    course,
    instructor,
    // Admins reach the instructor's overview through ?instructorId=.
    overviewHref:
      viewerIsAdmin
        ? `/instructor/analytics?instructorId=${instructor.id}&range=${range}`
        : `/instructor/analytics?range=${range}`,
    overview,
    revenueSeries: getRevenueSeries(instructor.id, range, course.id),
    enrollmentSeries: getEnrollmentSeries(instructor.id, range, course.id),
    revenueByCountry: getRevenueByCountry(instructor.id, range, course.id),
    revenueSplit: getRevenueSplit(instructor.id, range, course.id),
    funnel: getLessonFunnel(course.id),
  };
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="mt-2 h-5 w-80" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
      <Skeleton className="mt-6 h-96" />
    </div>
  );
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const {
    range,
    course,
    instructor,
    overviewHref,
    overview,
    revenueSeries,
    enrollmentSeries,
    revenueByCountry,
    revenueSplit,
    funnel,
  } = loaderData;

  const rangeHref = (r: AnalyticsRange) => `?range=${r}`;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to={overviewHref} className="hover:text-foreground">
          Analytics
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">{course.title}</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{course.title}</h1>
          <p className="mt-1 text-muted-foreground">
            Course analytics · {instructor.name}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link to={`/instructor/${course.id}/students`}>
            <Button variant="outline">
              <Users className="mr-2 size-4" />
              Student roster
            </Button>
          </Link>
          {overview.hasCourses && (
            <RangePicker range={range} hrefFor={rangeHref} />
          )}
        </div>
      </div>

      {!overview.hasCourses ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">Publish this course</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Analytics appear once the course is published. Draft courses
            aren't included.
          </p>
          <Link to={`/instructor/${course.id}`} className="mt-4">
            <Button>Go to Course Editor</Button>
          </Link>
        </Card>
      ) : (
        <div className="space-y-6">
          <HeadlineCards current={overview.current} previous={overview.previous} />

          <div className="grid gap-4 lg:grid-cols-2">
            <RevenueChart {...revenueSeries} />
            <EnrollmentChart {...enrollmentSeries} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <LessonFunnel {...funnel} />
            </div>
            <CompletionCard {...overview.completion} />
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
  let message = "An unexpected error occurred while loading course analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else if (error.status === 404) {
      title = "Course not found";
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
