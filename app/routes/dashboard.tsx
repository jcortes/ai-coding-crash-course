import { Link } from "react-router";
import type { Route } from "./+types/dashboard";
import { getUserEnrolledCourses } from "~/services/enrollmentService";
import { calculateProgress, getCompletedLessonCount, getTotalLessonCount, getNextIncompleteLesson } from "~/services/progressService";
import { getCurrentUserId } from "~/lib/session";
import { Card, CardContent, CardFooter, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { AlertTriangle, BookOpen, CheckCircle2, Flame, GraduationCap, PlayCircle } from "lucide-react";
import { CourseImage } from "~/components/course-image";
import { data, isRouteErrorResponse, redirect } from "react-router";
import { getUserById } from "~/services/userService";
import { UserRole } from "~/db/schema";
import {
  getStreakSummary,
  getUserBadges,
  markBadgesSeen,
} from "~/services/badgeService";
import { BADGE_CATALOG, STREAK_DAILY_GOAL } from "~/lib/badges";

export function meta() {
  return [
    { title: "Dashboard — Cadence" },
    { name: "description", content: "Your enrolled courses and progress" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view your dashboard.", {
      status: 401,
    });
  }

  if (getUserById(currentUserId)?.role === UserRole.Instructor) {
    throw redirect("/instructor/analytics");
  }

  const enrolledCourses = getUserEnrolledCourses(currentUserId);

  const coursesWithProgress = enrolledCourses.map((enrollment) => {
    const progress = calculateProgress(
      currentUserId,
      enrollment.courseId,
      false,
      false
    );
    const completedLessons = getCompletedLessonCount(
      currentUserId,
      enrollment.courseId
    );
    const totalLessons = getTotalLessonCount(enrollment.courseId);
    const nextLesson = getNextIncompleteLesson(
      currentUserId,
      enrollment.courseId
    );
    const isCompleted = enrollment.completedAt !== null;

    return {
      ...enrollment,
      progress,
      completedLessons,
      totalLessons,
      nextLessonId: nextLesson?.id ?? null,
      isCompleted,
    };
  });

  const completedCourses = coursesWithProgress.filter((c) => c.isCompleted);
  const inProgressCourses = coursesWithProgress.filter((c) => !c.isCompleted);

  // Read the badges before marking them seen so this visit still shows "New".
  const badges = getUserBadges(currentUserId).map((b) => ({
    id: b.id,
    type: b.type,
    title: b.title,
    awardedAt: b.awardedAt,
    isNew: b.seenAt === null,
  }));
  markBadgesSeen(currentUserId);

  const streak = getStreakSummary(currentUserId);

  return { inProgressCourses, completedCourses, badges, streak };
}

function StreakCounter({
  streak,
}: {
  streak: Route.ComponentProps["loaderData"]["streak"];
}) {
  const todayDone = Math.min(streak.lessonsToday, STREAK_DAILY_GOAL);
  return (
    <Card className="mb-8 flex-row items-center gap-4 p-4">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400">
        <Flame className="size-6" />
      </div>
      <div>
        <p className="font-semibold">
          Current streak: {streak.currentStreak}{" "}
          {streak.currentStreak === 1 ? "day" : "days"}
        </p>
        <p className="text-sm text-muted-foreground">
          {todayDone}/{STREAK_DAILY_GOAL} lessons today
        </p>
      </div>
    </Card>
  );
}

function MyBadges({
  badges,
}: {
  badges: Route.ComponentProps["loaderData"]["badges"];
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-4 text-xl font-semibold">My badges</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {badges.map((badge) => {
          const { name, icon: Icon, description } = BADGE_CATALOG[badge.type];
          return (
            <Card key={badge.id} className="flex-row items-center gap-4 p-4">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Icon className="size-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{name}</span>
                  {badge.isNew && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                      New
                    </span>
                  )}
                </div>
                <p className="truncate text-sm" title={description}>
                  {badge.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(badge.awardedAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function DashboardCardSkeleton() {
  return (
    <Card className="flex flex-col">
      <Skeleton className="aspect-video rounded-b-none rounded-t-lg" />
      <CardHeader>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-full" />
      </CardHeader>
      <CardContent className="flex-1">
        <div className="mb-2 flex items-center justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-10" />
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
      </CardContent>
      <CardFooter>
        <Skeleton className="h-10 w-full" />
      </CardFooter>
    </Card>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="mt-2 h-5 w-64" />
      </div>
      <Skeleton className="mb-4 h-6 w-32" />
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <DashboardCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { inProgressCourses, completedCourses, badges, streak } = loaderData;
  const totalCourses = inProgressCourses.length + completedCourses.length;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Dashboard</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">My Dashboard</h1>
        <p className="mt-1 text-muted-foreground">
          Track your learning progress
        </p>
      </div>

      <StreakCounter streak={streak} />

      {badges.length > 0 && <MyBadges badges={badges} />}

      {totalCourses === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No enrolled courses</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse the catalog to find courses and start learning.
          </p>
          <Link to="/courses" className="mt-4">
            <Button>Browse Courses</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-8">
          {/* In Progress Courses */}
          {inProgressCourses.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-semibold">In Progress</h2>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {inProgressCourses.map((course) => (
                  <Card key={course.enrollmentId} className="flex flex-col overflow-hidden pt-0">
                    <Link to={`/courses/${course.courseSlug}`} className="aspect-video overflow-hidden">
                      <CourseImage
                        src={course.coverImageUrl}
                        alt={course.courseTitle}
                        className="h-full w-full object-cover transition-transform hover:scale-105"
                      />
                    </Link>
                    <CardHeader>
                      <Link
                        to={`/courses/${course.courseSlug}`}
                        className="text-lg font-semibold leading-tight hover:text-primary"
                      >
                        {course.courseTitle}
                      </Link>
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {course.courseDescription}
                      </p>
                    </CardHeader>
                    <CardContent className="flex-1">
                      <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          {course.completedLessons} / {course.totalLessons}{" "}
                          lessons
                        </span>
                        <span className="font-medium">{course.progress}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${course.progress}%` }}
                        />
                      </div>
                    </CardContent>
                    <CardFooter>
                      {course.nextLessonId ? (
                        <Link
                          to={`/courses/${course.courseSlug}/lessons/${course.nextLessonId}`}
                          className="w-full"
                        >
                          <Button className="w-full" variant="outline">
                            <PlayCircle className="mr-2 size-4" />
                            Continue Learning
                          </Button>
                        </Link>
                      ) : (
                        <Link
                          to={`/courses/${course.courseSlug}`}
                          className="w-full"
                        >
                          <Button className="w-full" variant="outline">
                            <BookOpen className="mr-2 size-4" />
                            View Course
                          </Button>
                        </Link>
                      )}
                    </CardFooter>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {/* Completed Courses */}
          {completedCourses.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-semibold">Completed</h2>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {completedCourses.map((course) => (
                  <Card key={course.enrollmentId} className="flex flex-col overflow-hidden pt-0">
                    <Link to={`/courses/${course.courseSlug}`} className="relative aspect-video overflow-hidden">
                      <CourseImage
                        src={course.coverImageUrl}
                        alt={course.courseTitle}
                        className="h-full w-full object-cover transition-transform hover:scale-105"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                        <CheckCircle2 className="size-12 text-white" />
                      </div>
                    </Link>
                    <CardHeader>
                      <Link
                        to={`/courses/${course.courseSlug}`}
                        className="text-lg font-semibold leading-tight hover:text-primary"
                      >
                        {course.courseTitle}
                      </Link>
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {course.courseDescription}
                      </p>
                    </CardHeader>
                    <CardContent className="flex-1">
                      <div className="flex items-center gap-2 text-sm text-green-600">
                        <CheckCircle2 className="size-4" />
                        <span>
                          Completed — {course.totalLessons} lessons
                        </span>
                      </div>
                    </CardContent>
                    <CardFooter>
                      <Link
                        to={`/courses/${course.courseSlug}`}
                        className="w-full"
                      >
                        <Button className="w-full" variant="outline">
                          <BookOpen className="mr-2 size-4" />
                          Review Course
                        </Button>
                      </Link>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your dashboard.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
