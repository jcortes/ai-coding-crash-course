import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  coupons,
  courses,
  CourseStatus,
  enrollments,
  purchases,
  UserRole,
} from "~/db/schema";
import { getCountryTierInfo } from "~/lib/ppp";
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
      reason:
        "unauthenticated" | "forbidden" | "missing_instructor" | "not_found";
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

// ─── Time series ───

export type BucketSize = "day" | "week" | "month";

const BUCKET_SIZE: Record<AnalyticsRange, BucketSize> = {
  "7d": "day",
  "30d": "day",
  "90d": "week",
  all: "month",
};

// How each bucket size is computed. `sql` (grouping in the database) and
// `start` (zero-filling in JS) must map a timestamp to the same UTC
// "YYYY-MM-DD" bucket start, so they live side by side.
const BUCKETING: Record<
  BucketSize,
  {
    sql: (column: SQLiteColumn) => SQL<string>;
    start: (day: Date) => void;
    step: (bucket: Date) => void;
  }
> = {
  day: {
    sql: (column) => sql<string>`date(${column})`,
    start: () => {},
    step: (d) => d.setUTCDate(d.getUTCDate() + 1),
  },
  week: {
    // Forward to Sunday (or stay), then back to that week's Monday.
    sql: (column) => sql<string>`date(${column}, 'weekday 0', '-6 days')`,
    // getUTCDay(): Sunday = 0. Step back to Monday.
    start: (d) => d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)),
    step: (d) => d.setUTCDate(d.getUTCDate() + 7),
  },
  month: {
    sql: (column) => sql<string>`date(${column}, 'start of month')`,
    start: (d) => d.setUTCDate(1),
    step: (d) => d.setUTCMonth(d.getUTCMonth() + 1),
  },
};

function bucketExpr(column: SQLiteColumn, size: BucketSize) {
  return BUCKETING[size].sql(column);
}

function bucketStart(date: Date, size: BucketSize): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  BUCKETING[size].start(d);
  return d;
}

function nextBucket(date: Date, size: BucketSize): Date {
  const d = new Date(date);
  BUCKETING[size].step(d);
  return d;
}

// Every bucket start from the bucket containing `from` to the one containing `to`.
function bucketKeys(from: Date, to: Date, size: BucketSize): string[] {
  const keys: string[] = [];
  const last = bucketStart(to, size).getTime();
  for (
    let d = bucketStart(from, size);
    d.getTime() <= last;
    d = nextBucket(d, size)
  ) {
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

// Where the series begins: the window start, or for all time the earliest
// bucket with data (just the current bucket when there is none).
function seriesStart(
  window: DateWindow,
  rows: { bucket: string }[],
  now: Date
): Date {
  if (window.start) return new Date(window.start);
  const earliest = rows.reduce<string | null>(
    (min, r) => (min === null || r.bucket < min ? r.bucket : min),
    null
  );
  return earliest ? new Date(`${earliest}T00:00:00.000Z`) : now;
}

function countedCourseScope(instructorId: number, courseId: number | null) {
  return and(
    countedCoursesOf(instructorId),
    courseId !== null ? eq(courses.id, courseId) : undefined
  );
}

// Lays the grouped rows onto the full list of buckets, zero-filling gaps.
function fillSeries<T extends { bucket: string }>(
  rows: T[],
  window: DateWindow,
  size: BucketSize,
  now: Date,
  empty: Omit<T, "bucket">
): T[] {
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  return bucketKeys(seriesStart(window, rows, now), now, size).map(
    (key) => byBucket.get(key) ?? ({ ...empty, bucket: key } as T)
  );
}

export function getRevenueSeries(
  instructorId: number,
  range: AnalyticsRange,
  courseId: number | null = null,
  now: Date = new Date()
) {
  const size = BUCKET_SIZE[range];
  const { current } = getWindows(range, now);
  const bucket = bucketExpr(purchases.createdAt, size);

  const rows = db
    .select({
      bucket,
      revenue: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
      sales: sql<number>`count(${purchases.id})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        countedCourseScope(instructorId, courseId),
        withinWindow(purchases.createdAt, current)
      )
    )
    .groupBy(bucket)
    .all();

  return {
    bucketSize: size,
    points: fillSeries(rows, current, size, now, { revenue: 0, sales: 0 }),
  };
}

export function getEnrollmentSeries(
  instructorId: number,
  range: AnalyticsRange,
  courseId: number | null = null,
  now: Date = new Date()
) {
  const size = BUCKET_SIZE[range];
  const { current } = getWindows(range, now);
  const bucket = bucketExpr(enrollments.enrolledAt, size);

  const rows = db
    .select({
      bucket,
      enrollments: sql<number>`count(${enrollments.id})`,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(
        countedCourseScope(instructorId, courseId),
        withinWindow(enrollments.enrolledAt, current)
      )
    )
    .groupBy(bucket)
    .all();

  return {
    bucketSize: size,
    points: fillSeries(rows, current, size, now, { enrollments: 0 }),
  };
}

// ─── Revenue breakdowns ───

export function getRevenueByCountry(
  instructorId: number,
  range: AnalyticsRange,
  courseId: number | null = null,
  now: Date = new Date()
) {
  const { current } = getWindows(range, now);
  const revenue = sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`;

  const rows = db
    .select({
      country: purchases.country,
      revenue,
      sales: sql<number>`count(${purchases.id})`,
      discount: sql<number>`coalesce(sum(${purchases.listPrice} * ${purchases.quantity} - ${purchases.amountPaid}), 0)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        countedCourseScope(instructorId, courseId),
        withinWindow(purchases.createdAt, current)
      )
    )
    .groupBy(purchases.country)
    .orderBy(desc(revenue), purchases.country)
    .all();

  return rows.map((row) => {
    const { tier, label } = getCountryTierInfo(row.country);
    return {
      country: row.country,
      tier,
      tierLabel: label,
      revenue: row.revenue,
      sales: row.sales,
      discount: row.discount,
    };
  });
}

// A purchase is a team purchase when it generated coupons (a team may buy a
// single seat, so quantity alone can't tell them apart).
export function getRevenueSplit(
  instructorId: number,
  range: AnalyticsRange,
  courseId: number | null = null,
  now: Date = new Date()
) {
  const { current } = getWindows(range, now);
  const isTeam = sql<number>`exists (select 1 from ${coupons} where ${coupons.purchaseId} = ${purchases.id})`;

  const rows = db
    .select({
      isTeam,
      revenue: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
      sales: sql<number>`count(${purchases.id})`,
      seats: sql<number>`coalesce(sum(${purchases.quantity}), 0)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        countedCourseScope(instructorId, courseId),
        withinWindow(purchases.createdAt, current)
      )
    )
    .groupBy(isTeam)
    .all();

  const splitPart = (team: boolean) => {
    const row = rows.find((r) => Boolean(r.isTeam) === team);
    return {
      revenue: row?.revenue ?? 0,
      sales: row?.sales ?? 0,
      seats: row?.seats ?? 0,
    };
  };

  return { individual: splitPart(false), team: splitPart(true) };
}
