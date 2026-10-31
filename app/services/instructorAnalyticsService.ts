import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  courses,
  CourseStatus,
  enrollments,
  purchases,
  UserRole,
} from "~/db/schema";
import { getUserById } from "./userService";

// ─── Instructor Analytics Service ───
// Live SQL aggregates for the instructor analytics dashboard.
// Uses positional parameters (project convention).

export type AnalyticsRange = "7d" | "30d" | "90d" | "all";

export const ANALYTICS_RANGES: AnalyticsRange[] = ["7d", "30d", "90d", "all"];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = "30d";

export function parseAnalyticsRange(value: string | null): AnalyticsRange {
  return ANALYTICS_RANGES.find((r) => r === value) ?? DEFAULT_ANALYTICS_RANGE;
}

export type AnalyticsAccess =
  | { ok: true; instructor: { id: number; name: string } }
  | {
      ok: false;
      reason: "unauthenticated" | "forbidden" | "missing_instructor" | "not_found";
    };

// Decides whose analytics the viewer may see. Instructors are always locked to
// themselves (any requested id is ignored); admins must name an instructor.
export function resolveAnalyticsInstructor(
  viewerId: number | null,
  requestedInstructorId: number | null
): AnalyticsAccess {
  if (viewerId === null) return { ok: false, reason: "unauthenticated" };

  const viewer = getUserById(viewerId);
  if (!viewer) return { ok: false, reason: "unauthenticated" };

  if (viewer.role === UserRole.Instructor) {
    return { ok: true, instructor: { id: viewer.id, name: viewer.name } };
  }

  if (viewer.role !== UserRole.Admin) return { ok: false, reason: "forbidden" };

  if (requestedInstructorId === null) {
    return { ok: false, reason: "missing_instructor" };
  }

  const target = getUserById(requestedInstructorId);
  if (!target || target.role !== UserRole.Instructor) {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true, instructor: { id: target.id, name: target.name } };
}

const RANGE_DAYS: Record<Exclude<AnalyticsRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const COUNTED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

// Half-open interval [start, end). A null bound is unbounded.
interface DateWindow {
  start: string | null;
  end: string | null;
}

function getWindows(
  range: AnalyticsRange,
  now: Date
): { current: DateWindow; previous: DateWindow | null } {
  if (range === "all") {
    return { current: { start: null, end: null }, previous: null };
  }
  const lengthMs = RANGE_DAYS[range] * DAY_MS;
  const currentStart = new Date(now.getTime() - lengthMs).toISOString();
  const previousStart = new Date(now.getTime() - 2 * lengthMs).toISOString();
  return {
    current: { start: currentStart, end: null },
    previous: { start: previousStart, end: currentStart },
  };
}

// Courses that count towards an instructor's analytics: theirs, and not drafts.
function countedCoursesOf(instructorId: number) {
  return and(
    eq(courses.instructorId, instructorId),
    inArray(courses.status, COUNTED_STATUSES)
  );
}

function withinWindow(column: SQLiteColumn, window: DateWindow) {
  const conditions: SQL[] = [];
  if (window.start) conditions.push(gte(column, window.start));
  if (window.end) conditions.push(lt(column, window.end));
  return and(...conditions);
}

function getRevenueAndSales(instructorId: number, window: DateWindow) {
  const row = db
    .select({
      revenue: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
      sales: sql<number>`count(${purchases.id})`,
      seats: sql<number>`coalesce(sum(${purchases.quantity}), 0)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        countedCoursesOf(instructorId),
        withinWindow(purchases.createdAt, window)
      )
    )
    .get();

  return {
    revenue: row?.revenue ?? 0,
    sales: row?.sales ?? 0,
    seats: row?.seats ?? 0,
  };
}

function getNewEnrollments(instructorId: number, window: DateWindow) {
  const row = db
    .select({ count: sql<number>`count(${enrollments.id})` })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(
        countedCoursesOf(instructorId),
        withinWindow(enrollments.enrolledAt, window)
      )
    )
    .get();

  return row?.count ?? 0;
}

function getPeriodTotals(instructorId: number, window: DateWindow) {
  return {
    ...getRevenueAndSales(instructorId, window),
    newEnrollments: getNewEnrollments(instructorId, window),
  };
}

function hasCountedCourses(instructorId: number) {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(countedCoursesOf(instructorId))
    .limit(1)
    .get();
  return row !== undefined;
}

export function getInstructorOverview(
  instructorId: number,
  range: AnalyticsRange,
  now: Date = new Date()
) {
  const windows = getWindows(range, now);
  return {
    hasCourses: hasCountedCourses(instructorId),
    current: getPeriodTotals(instructorId, windows.current),
    previous: windows.previous
      ? getPeriodTotals(instructorId, windows.previous)
      : null,
  };
}
