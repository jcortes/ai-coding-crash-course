import { and, desc, eq, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  coupons,
  courses,
  CourseStatus,
  enrollments,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  UserRole,
  users,
} from "~/db/schema";
import { getCountryTierInfo } from "~/lib/ppp";
import { getUserById } from "./userService";
import type { AnalyticsRange } from "~/lib/analytics-range";

// ─── Instructor Analytics Service ───
// Live SQL aggregates for the instructor analytics dashboard.
// Uses positional parameters (project convention).

export {
  ANALYTICS_RANGES,
  DEFAULT_ANALYTICS_RANGE,
  parseAnalyticsRange,
  type AnalyticsRange,
} from "~/lib/analytics-range";

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

export type CourseAnalyticsAccess =
  | {
      ok: true;
      course: { id: number; title: string; status: CourseStatus };
      instructor: { id: number; name: string };
      viewerIsAdmin: boolean;
    }
  | { ok: false; reason: "unauthenticated" | "forbidden" | "not_found" };

// A course's analytics are open to its owner and to admins only.
export function resolveCourseAnalyticsAccess(
  viewerId: number | null,
  courseId: number
): CourseAnalyticsAccess {
  if (viewerId === null) return { ok: false, reason: "unauthenticated" };

  const viewer = getUserById(viewerId);
  if (!viewer) return { ok: false, reason: "unauthenticated" };

  const course = db
    .select({
      id: courses.id,
      title: courses.title,
      status: courses.status,
      instructorId: courses.instructorId,
    })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course) return { ok: false, reason: "not_found" };

  const isOwner =
    viewer.role === UserRole.Instructor && course.instructorId === viewer.id;
  if (!isOwner && viewer.role !== UserRole.Admin) {
    return { ok: false, reason: "forbidden" };
  }

  const instructor = getUserById(course.instructorId);
  if (!instructor) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    course: { id: course.id, title: course.title, status: course.status },
    instructor: { id: instructor.id, name: instructor.name },
    viewerIsAdmin: viewer.role === UserRole.Admin,
  };
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

function getRevenueAndSales(
  instructorId: number,
  courseId: number | null,
  window: DateWindow
) {
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
        countedCourseScope(instructorId, courseId),
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

function getNewEnrollments(
  instructorId: number,
  courseId: number | null,
  window: DateWindow
) {
  const row = db
    .select({ count: sql<number>`count(${enrollments.id})` })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(
        countedCourseScope(instructorId, courseId),
        withinWindow(enrollments.enrolledAt, window)
      )
    )
    .get();

  return row?.count ?? 0;
}

function getPeriodTotals(
  instructorId: number,
  courseId: number | null,
  window: DateWindow
) {
  return {
    ...getRevenueAndSales(instructorId, courseId, window),
    newEnrollments: getNewEnrollments(instructorId, courseId, window),
  };
}

function hasCountedCourses(instructorId: number, courseId: number | null) {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(countedCourseScope(instructorId, courseId))
    .limit(1)
    .get();
  return row !== undefined;
}

// ─── Completion (always all-time) ───

export interface CompletionMetrics {
  /**
   * Enrollments that count (not the course's instructor, not admins). Pooled
   * across courses, a student in two courses counts twice.
   */
  enrolledStudents: number;
  /** Share (0–1) of those students who completed every lesson; null if none. */
  completionRate: number | null;
  /** Mean share (0–1) of lessons completed per student; null if none. */
  averageCompletion: number | null;
}

interface CompletionTotals {
  students: number;
  finished: number;
  progressSum: number;
}

const NO_COMPLETION: CompletionTotals = {
  students: 0,
  finished: 0,
  progressSum: 0,
};

function toCompletionMetrics(totals: CompletionTotals): CompletionMetrics {
  const { students, finished, progressSum } = totals;
  return {
    enrolledStudents: students,
    completionRate: students > 0 ? finished / students : null,
    averageCompletion: students > 0 ? progressSum / students : null,
  };
}

// Who counts in completion and funnel numbers: every enrolled student except
// the course's own instructor and admins. Needs `courses` and `users` joined
// onto `enrollments`.
function isCountedLearner() {
  return and(
    ne(enrollments.userId, courses.instructorId),
    ne(users.role, UserRole.Admin)
  );
}

// Completion totals per counted course of the instructor (or just `courseId`),
// ignoring any date range. The course's own instructor and admins are left out. A course with no
// lessons has nothing to finish, so its students count as 0% complete.
function getCompletionTotalsByCourse(
  instructorId: number,
  courseId: number | null = null
) {
  const totalLessons = sql<number>`(
    select count(*) from ${lessons}
    inner join ${modules} on ${lessons.moduleId} = ${modules.id}
    where ${modules.courseId} = ${enrollments.courseId}
  )`;
  const completedLessons = sql<number>`(
    select count(distinct ${lessonProgress.lessonId}) from ${lessonProgress}
    inner join ${lessons} on ${lessonProgress.lessonId} = ${lessons.id}
    inner join ${modules} on ${lessons.moduleId} = ${modules.id}
    where ${modules.courseId} = ${enrollments.courseId}
      and ${lessonProgress.userId} = ${enrollments.userId}
      and ${lessonProgress.status} = ${LessonProgressStatus.Completed}
  )`;

  const perEnrollment = db
    .select({
      courseId: enrollments.courseId,
      total: totalLessons.as("total_lessons"),
      done: completedLessons.as("completed_lessons"),
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .innerJoin(users, eq(enrollments.userId, users.id))
    .where(
      and(
        countedCourseScope(instructorId, courseId),
        isCountedLearner()
      )
    )
    .as("per_enrollment");

  return db
    .select({
      courseId: perEnrollment.courseId,
      students: sql<number>`count(*)`,
      finished: sql<number>`sum(case when ${perEnrollment.total} > 0 and ${perEnrollment.done} >= ${perEnrollment.total} then 1 else 0 end)`,
      progressSum: sql<number>`sum(case when ${perEnrollment.total} > 0 then ${perEnrollment.done} * 1.0 / ${perEnrollment.total} else 0 end)`,
    })
    .from(perEnrollment)
    .groupBy(perEnrollment.courseId)
    .all();
}

function getCompletionMetrics(
  instructorId: number,
  courseId: number | null
): CompletionMetrics {
  const totals = getCompletionTotalsByCourse(instructorId, courseId).reduce<CompletionTotals>(
    (sum, row) => ({
      students: sum.students + row.students,
      finished: sum.finished + row.finished,
      progressSum: sum.progressSum + row.progressSum,
    }),
    NO_COMPLETION
  );
  return toCompletionMetrics(totals);
}

// Headline numbers for the instructor's counted courses, or for just
// `courseId` when given.
export function getInstructorOverview(
  instructorId: number,
  range: AnalyticsRange,
  courseId: number | null = null,
  now: Date = new Date()
) {
  const windows = getWindows(range, now);
  return {
    hasCourses: hasCountedCourses(instructorId, courseId),
    current: getPeriodTotals(instructorId, courseId, windows.current),
    previous: windows.previous
      ? getPeriodTotals(instructorId, courseId, windows.previous)
      : null,
    completion: getCompletionMetrics(instructorId, courseId),
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

// ─── Per-course breakdown ───

// One row per published or archived course of the instructor. Revenue and
// sales follow the range; completion numbers are all-time. Sorted by revenue,
// highest first, then by title.
export function getCourseBreakdown(
  instructorId: number,
  range: AnalyticsRange,
  now: Date = new Date()
) {
  const { current } = getWindows(range, now);

  const courseRows = db
    .select({ id: courses.id, title: courses.title, status: courses.status })
    .from(courses)
    .where(countedCoursesOf(instructorId))
    .all();

  const salesByCourse = new Map(
    db
      .select({
        courseId: purchases.courseId,
        revenue: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
        sales: sql<number>`count(${purchases.id})`,
      })
      .from(purchases)
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(
        and(
          countedCoursesOf(instructorId),
          withinWindow(purchases.createdAt, current)
        )
      )
      .groupBy(purchases.courseId)
      .all()
      .map((row) => [row.courseId, row])
  );

  const completionByCourse = new Map(
    getCompletionTotalsByCourse(instructorId).map((row) => [row.courseId, row])
  );

  return courseRows
    .map((course) => {
      const sales = salesByCourse.get(course.id);
      return {
        courseId: course.id,
        title: course.title,
        status: course.status,
        revenue: sales?.revenue ?? 0,
        sales: sales?.sales ?? 0,
        ...toCompletionMetrics(
          completionByCourse.get(course.id) ?? NO_COMPLETION
        ),
      };
    })
    .sort((a, b) => b.revenue - a.revenue || a.title.localeCompare(b.title));
}

// ─── Lesson funnel (always all-time) ───

// Enrolled students of the course whose progress counts in the funnel.
function countedLearnerIds(courseId: number) {
  return db
    .selectDistinct({ userId: enrollments.userId })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .innerJoin(users, eq(enrollments.userId, users.id))
    .where(
      and(
        eq(enrollments.courseId, courseId),
        isCountedLearner()
      )
    );
}

const STEEPEST_DROPS = 3;

export interface FunnelLesson {
  id: number;
  title: string;
  reached: number;
  reachedShare: number | null;
  completed: number;
  completedShare: number | null;
  /** Fall in reached share (0–1) since the previous lesson; null for the first. */
  drop: number | null;
  /** One of the (up to) three lessons losing the most students. */
  steepestDrop: boolean;
  /** Present when the lesson has a quiz; the rate is null until attempted. */
  quiz: { attempted: number; passed: number; passRate: number | null } | null;
}

function share(count: number, total: number): number | null {
  return total > 0 ? count / total : null;
}

export function getLessonFunnel(courseId: number) {
  const learnerIds = countedLearnerIds(courseId);
  const learners = learnerIds.as("learners");
  const students =
    db.select({ count: sql<number>`count(*)` }).from(learners).get()?.count ??
    0;

  const lessonRows = db
    .select({
      id: lessons.id,
      title: lessons.title,
      moduleId: modules.id,
      moduleTitle: modules.title,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, modules.id, lessons.position, lessons.id)
    .all();

  const progressByLesson = new Map(
    db
      .select({
        lessonId: lessonProgress.lessonId,
        reached: sql<number>`count(distinct case when ${lessonProgress.status} in (${LessonProgressStatus.InProgress}, ${LessonProgressStatus.Completed}) then ${lessonProgress.userId} end)`,
        completed: sql<number>`count(distinct case when ${lessonProgress.status} = ${LessonProgressStatus.Completed} then ${lessonProgress.userId} end)`,
      })
      .from(lessonProgress)
      .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(
        and(
          eq(modules.courseId, courseId),
          inArray(lessonProgress.userId, learnerIds)
        )
      )
      .groupBy(lessonProgress.lessonId)
      .all()
      .map((row) => [row.lessonId, row])
  );

  // Per lesson with a quiz: counted students who attempted any of its quizzes,
  // and those with at least one passing attempt.
  const quizByLesson = new Map(
    db
      .select({
        lessonId: quizzes.lessonId,
        attempted: sql<number>`count(distinct ${quizAttempts.userId})`,
        passed: sql<number>`count(distinct case when ${quizAttempts.passed} then ${quizAttempts.userId} end)`,
      })
      .from(quizzes)
      .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .leftJoin(
        quizAttempts,
        and(
          eq(quizAttempts.quizId, quizzes.id),
          inArray(quizAttempts.userId, learnerIds)
        )
      )
      .where(eq(modules.courseId, courseId))
      .groupBy(quizzes.lessonId)
      .all()
      .map((row) => [
        row.lessonId,
        {
          attempted: row.attempted,
          passed: row.passed,
          passRate: share(row.passed, row.attempted),
        },
      ])
  );

  const funnelLessons = lessonRows.map((row, index) => {
    const reached = progressByLesson.get(row.id)?.reached ?? 0;
    const completed = progressByLesson.get(row.id)?.completed ?? 0;
    const previousReached =
      index > 0 ? (progressByLesson.get(lessonRows[index - 1].id)?.reached ?? 0) : null;
    const lostStudents =
      previousReached === null ? null : previousReached - reached;
    return {
      ...row,
      reached,
      reachedShare: share(reached, students),
      completed,
      completedShare: share(completed, students),
      lostStudents,
      drop: lostStudents === null ? null : share(lostStudents, students),
      steepestDrop: false,
      quiz: quizByLesson.get(row.id) ?? null,
    };
  });

  // Flag the (up to) three lessons that lose the most students; ties go to
  // the earlier lesson. Lessons that lose nobody are never flagged.
  funnelLessons
    .filter((l) => l.lostStudents !== null && l.lostStudents > 0)
    .sort((a, b) => b.lostStudents! - a.lostStudents!)
    .slice(0, STEEPEST_DROPS)
    .forEach((l) => (l.steepestDrop = true));

  const funnelModules: {
    id: number;
    title: string;
    lessons: FunnelLesson[];
  }[] = [];
  for (const { moduleId, moduleTitle, lostStudents: _, ...lesson } of funnelLessons) {
    let mod = funnelModules.at(-1);
    if (!mod || mod.id !== moduleId) {
      mod = { id: moduleId, title: moduleTitle, lessons: [] };
      funnelModules.push(mod);
    }
    mod.lessons.push(lesson);
  }

  return { students, modules: funnelModules };
}
