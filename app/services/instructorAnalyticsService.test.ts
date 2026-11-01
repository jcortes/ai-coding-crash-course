import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { generateCoupons } from "./couponService";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getCourseBreakdown,
  getInstructorOverview,
  getEnrollmentSeries,
  getRevenueByCountry,
  getRevenueSeries,
  getRevenueSplit,
  parseAnalyticsRange,
  resolveAnalyticsInstructor,
} from "./instructorAnalyticsService";

const NOW = new Date("2026-06-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

let userCounter = 0;
function createUser(role: schema.UserRole) {
  userCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `User ${userCounter}`,
      email: `user${userCounter}@example.com`,
      role,
    })
    .returning()
    .get();
}

function createStudent() {
  return createUser(schema.UserRole.Student);
}

function addPurchase(opts: {
  courseId?: number;
  amountPaid: number;
  createdAt: string;
  quantity?: number;
  listPrice?: number;
  country?: string | null;
}) {
  const buyer = createStudent();
  return testDb
    .insert(schema.purchases)
    .values({
      userId: buyer.id,
      courseId: opts.courseId ?? base.course.id,
      amountPaid: opts.amountPaid,
      listPrice: opts.listPrice ?? opts.amountPaid,
      quantity: opts.quantity ?? 1,
      country: opts.country === undefined ? "US" : opts.country,
      createdAt: opts.createdAt,
    })
    .returning()
    .get();
}

// A team purchase: the purchase plus one coupon per seat.
function addTeamPurchase(opts: {
  courseId?: number;
  amountPaid: number;
  quantity: number;
  createdAt: string;
}) {
  const purchase = addPurchase(opts);
  const team = testDb.insert(schema.teams).values({}).returning().get();
  generateCoupons(team.id, purchase.courseId, purchase.id, opts.quantity);
  return purchase;
}

function addEnrollment(opts: { courseId?: number; enrolledAt: string }) {
  const student = createStudent();
  return testDb
    .insert(schema.enrollments)
    .values({
      userId: student.id,
      courseId: opts.courseId ?? base.course.id,
      enrolledAt: opts.enrolledAt,
    })
    .returning()
    .get();
}

let courseCounter = 0;
function createCourse(
  status: schema.CourseStatus,
  instructorId: number = base.instructor.id
) {
  courseCounter++;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${courseCounter}`,
      slug: `course-${courseCounter}`,
      description: "desc",
      salesCopy: "copy",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

// Adds a module per entry in `lessonsPerModule`, each with that many lessons.
// Returns lesson ids in module-then-lesson order.
function addLessons(courseId: number, lessonsPerModule: number[]) {
  const ids: number[] = [];
  lessonsPerModule.forEach((count, m) => {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId, title: `Module ${m + 1}`, position: m + 1 })
      .returning()
      .get();
    for (let l = 0; l < count; l++) {
      const lesson = testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${l + 1}`, position: l + 1 })
        .returning()
        .get();
      ids.push(lesson.id);
    }
  });
  return ids;
}

// Enrolls a user (a new student by default) and records their lesson progress.
function addLearner(opts: {
  courseId?: number;
  completed?: number[];
  inProgress?: number[];
  userId?: number;
  enrolledAt?: string;
}) {
  const userId = opts.userId ?? createStudent().id;
  testDb
    .insert(schema.enrollments)
    .values({
      userId,
      courseId: opts.courseId ?? base.course.id,
      enrolledAt: opts.enrolledAt ?? daysAgo(100),
    })
    .run();
  const progress = [
    ...(opts.completed ?? []).map((lessonId) => ({
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })),
    ...(opts.inProgress ?? []).map((lessonId) => ({
      lessonId,
      status: schema.LessonProgressStatus.InProgress,
    })),
  ];
  for (const row of progress) {
    testDb.insert(schema.lessonProgress).values({ userId, ...row }).run();
  }
  return userId;
}

describe("instructorAnalyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorOverview", () => {
    it("sums revenue and counts sales within the selected range", () => {
      addPurchase({ amountPaid: 5000, createdAt: daysAgo(1) });
      addPurchase({ amountPaid: 3000, createdAt: daysAgo(10) });
      addPurchase({ amountPaid: 9999, createdAt: daysAgo(45) });

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.current.revenue).toBe(8000);
      expect(overview.current.sales).toBe(2);
    });

    it("reports the previous period of equal length for comparison", () => {
      addPurchase({ amountPaid: 5000, createdAt: daysAgo(3) });
      addPurchase({ amountPaid: 2000, createdAt: daysAgo(8) });
      addPurchase({ amountPaid: 1500, createdAt: daysAgo(13) });
      addPurchase({ amountPaid: 7777, createdAt: daysAgo(20) });

      const overview = getInstructorOverview(base.instructor.id, "7d", NOW);

      expect(overview.current.revenue).toBe(5000);
      expect(overview.previous).toEqual(
        expect.objectContaining({ revenue: 3500, sales: 2 })
      );
    });

    it("counts a team purchase as one sale and N seats", () => {
      addPurchase({ amountPaid: 4000, createdAt: daysAgo(2) });
      addPurchase({ amountPaid: 25000, quantity: 5, createdAt: daysAgo(4) });

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.current.sales).toBe(2);
      expect(overview.current.seats).toBe(6);
      expect(overview.current.revenue).toBe(29000);
    });

    it("counts new enrollments by enrollment date for both periods", () => {
      addEnrollment({ enrolledAt: daysAgo(1) });
      addEnrollment({ enrolledAt: daysAgo(6) });
      addEnrollment({ enrolledAt: daysAgo(9) });
      addEnrollment({ enrolledAt: daysAgo(30) });

      const overview = getInstructorOverview(base.instructor.id, "7d", NOW);

      expect(overview.current.newEnrollments).toBe(2);
      expect(overview.previous?.newEnrollments).toBe(1);
    });

    it("excludes draft courses and includes archived courses", () => {
      const draft = createCourse(schema.CourseStatus.Draft);
      const archived = createCourse(schema.CourseStatus.Archived);
      addPurchase({ courseId: draft.id, amountPaid: 1111, createdAt: daysAgo(1) });
      addPurchase({ courseId: archived.id, amountPaid: 2000, createdAt: daysAgo(1) });
      addEnrollment({ courseId: draft.id, enrolledAt: daysAgo(1) });
      addEnrollment({ courseId: archived.id, enrolledAt: daysAgo(1) });

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.current).toEqual({
        revenue: 2000,
        sales: 1,
        seats: 1,
        newEnrollments: 1,
      });
    });

    it("only counts the given instructor's courses", () => {
      const otherInstructor = createUser(schema.UserRole.Instructor);
      const otherCourse = createCourse(
        schema.CourseStatus.Published,
        otherInstructor.id
      );
      addPurchase({ amountPaid: 1000, createdAt: daysAgo(1) });
      addPurchase({ courseId: otherCourse.id, amountPaid: 5000, createdAt: daysAgo(1) });

      expect(
        getInstructorOverview(base.instructor.id, "30d", NOW).current.revenue
      ).toBe(1000);
      expect(
        getInstructorOverview(otherInstructor.id, "30d", NOW).current.revenue
      ).toBe(5000);
    });

    it("reports whether the instructor has any published or archived course", () => {
      const draftOnly = createUser(schema.UserRole.Instructor);
      createCourse(schema.CourseStatus.Draft, draftOnly.id);
      const archivedOnly = createUser(schema.UserRole.Instructor);
      createCourse(schema.CourseStatus.Archived, archivedOnly.id);

      expect(getInstructorOverview(base.instructor.id, "30d", NOW).hasCourses).toBe(true);
      expect(getInstructorOverview(draftOnly.id, "30d", NOW).hasCourses).toBe(false);
      expect(getInstructorOverview(archivedOnly.id, "30d", NOW).hasCourses).toBe(true);
    });

    it("has no previous period for all time", () => {
      addPurchase({ amountPaid: 5000, createdAt: daysAgo(3) });
      addPurchase({ amountPaid: 2000, createdAt: daysAgo(400) });

      const overview = getInstructorOverview(base.instructor.id, "all", NOW);

      expect(overview.current.revenue).toBe(7000);
      expect(overview.current.sales).toBe(2);
      expect(overview.previous).toBeNull();
    });

    it("counts a purchase exactly on the period boundary in the current period only", () => {
      addPurchase({ amountPaid: 1000, createdAt: daysAgo(7) });

      const overview = getInstructorOverview(base.instructor.id, "7d", NOW);

      expect(overview.current.revenue).toBe(1000);
      expect(overview.previous?.revenue).toBe(0);
    });

    it("excludes purchases older than the previous period", () => {
      addPurchase({ amountPaid: 1000, createdAt: daysAgo(14) });
      addPurchase({ amountPaid: 2000, createdAt: daysAgo(14.0001) });

      const overview = getInstructorOverview(base.instructor.id, "7d", NOW);

      expect(overview.previous?.revenue).toBe(1000);
    });
  });

  describe("getRevenueSeries", () => {
    it("buckets revenue by day for 7d, filling empty days with zero", () => {
      addPurchase({ amountPaid: 1000, createdAt: "2026-06-30T08:00:00.000Z" });
      addPurchase({ amountPaid: 500, createdAt: "2026-06-30T01:00:00.000Z" });
      addPurchase({ amountPaid: 2000, createdAt: "2026-06-25T23:59:00.000Z" });
      addPurchase({ amountPaid: 9999, createdAt: "2026-06-20T10:00:00.000Z" });

      const series = getRevenueSeries(base.instructor.id, "7d", null, NOW);

      expect(series.bucketSize).toBe("day");
      expect(series.points).toEqual([
        { bucket: "2026-06-23", revenue: 0, sales: 0 },
        { bucket: "2026-06-24", revenue: 0, sales: 0 },
        { bucket: "2026-06-25", revenue: 2000, sales: 1 },
        { bucket: "2026-06-26", revenue: 0, sales: 0 },
        { bucket: "2026-06-27", revenue: 0, sales: 0 },
        { bucket: "2026-06-28", revenue: 0, sales: 0 },
        { bucket: "2026-06-29", revenue: 0, sales: 0 },
        { bucket: "2026-06-30", revenue: 1500, sales: 2 },
      ]);
    });

    it("buckets revenue by Monday-start week for 90d", () => {
      // NOW is Tuesday 2026-06-30; 90 days back is Wednesday 2026-04-01.
      addPurchase({ amountPaid: 100, createdAt: "2026-04-02T10:00:00.000Z" });
      addPurchase({ amountPaid: 200, createdAt: "2026-06-28T23:00:00.000Z" }); // Sunday
      addPurchase({ amountPaid: 400, createdAt: "2026-06-29T00:30:00.000Z" }); // Monday
      addPurchase({ amountPaid: 800, createdAt: "2026-03-31T10:00:00.000Z" }); // outside range

      const series = getRevenueSeries(base.instructor.id, "90d", null, NOW);

      expect(series.bucketSize).toBe("week");
      expect(series.points).toHaveLength(14);
      expect(series.points[0]).toEqual({ bucket: "2026-03-30", revenue: 100, sales: 1 });
      expect(series.points[1]).toEqual({ bucket: "2026-04-06", revenue: 0, sales: 0 });
      expect(series.points.at(-2)).toEqual({ bucket: "2026-06-22", revenue: 200, sales: 1 });
      expect(series.points.at(-1)).toEqual({ bucket: "2026-06-29", revenue: 400, sales: 1 });
    });

    it("buckets revenue by month for all time, from the first sale to now", () => {
      addPurchase({ amountPaid: 100, createdAt: "2025-11-15T10:00:00.000Z" });
      addPurchase({ amountPaid: 200, createdAt: "2026-02-03T10:00:00.000Z" });
      addPurchase({ amountPaid: 300, createdAt: "2026-02-28T23:59:00.000Z" });

      const series = getRevenueSeries(base.instructor.id, "all", null, NOW);

      expect(series.bucketSize).toBe("month");
      expect(series.points).toEqual([
        { bucket: "2025-11-01", revenue: 100, sales: 1 },
        { bucket: "2025-12-01", revenue: 0, sales: 0 },
        { bucket: "2026-01-01", revenue: 0, sales: 0 },
        { bucket: "2026-02-01", revenue: 500, sales: 2 },
        { bucket: "2026-03-01", revenue: 0, sales: 0 },
        { bucket: "2026-04-01", revenue: 0, sales: 0 },
        { bucket: "2026-05-01", revenue: 0, sales: 0 },
        { bucket: "2026-06-01", revenue: 0, sales: 0 },
      ]);
    });

    it("shows only the current month for all time when there are no sales", () => {
      const series = getRevenueSeries(base.instructor.id, "all", null, NOW);

      expect(series.points).toEqual([
        { bucket: "2026-06-01", revenue: 0, sales: 0 },
      ]);
    });
  });

  describe("getEnrollmentSeries", () => {
    it("buckets new enrollments by enrollment date with zero-filled days", () => {
      addEnrollment({ enrolledAt: "2026-06-30T09:00:00.000Z" });
      addEnrollment({ enrolledAt: "2026-06-01T13:00:00.000Z" });
      addEnrollment({ enrolledAt: "2026-06-01T15:00:00.000Z" });
      addEnrollment({ enrolledAt: "2026-05-31T11:59:00.000Z" }); // just outside 30d

      const series = getEnrollmentSeries(base.instructor.id, "30d", null, NOW);

      expect(series.bucketSize).toBe("day");
      expect(series.points).toHaveLength(31);
      expect(series.points[0]).toEqual({ bucket: "2026-05-31", enrollments: 0 });
      expect(series.points[1]).toEqual({ bucket: "2026-06-01", enrollments: 2 });
      expect(series.points[2]).toEqual({ bucket: "2026-06-02", enrollments: 0 });
      expect(series.points.at(-1)).toEqual({ bucket: "2026-06-30", enrollments: 1 });
    });
  });

  describe("getRevenueByCountry", () => {
    it("reports revenue, sales, PPP tier and discount given per country", () => {
      addPurchase({ country: "US", listPrice: 10000, amountPaid: 10000, createdAt: daysAgo(1) });
      addPurchase({ country: "IN", listPrice: 10000, amountPaid: 5000, createdAt: daysAgo(2) });
      addPurchase({ country: "IN", listPrice: 8000, amountPaid: 4000, createdAt: daysAgo(3) });
      addPurchase({ country: "IN", listPrice: 10000, amountPaid: 5000, createdAt: daysAgo(40) });
      // Team of 3 seats in Brazil (tier 2, 30% off): 3 x 10000 list, 21000 paid.
      addPurchase({ country: "BR", listPrice: 10000, amountPaid: 21000, quantity: 3, createdAt: daysAgo(4) });

      const rows = getRevenueByCountry(base.instructor.id, "30d", null, NOW);

      expect(rows).toEqual([
        { country: "BR", tier: 2, tierLabel: "30% off", revenue: 21000, sales: 1, discount: 9000 },
        { country: "US", tier: 1, tierLabel: "Full Price", revenue: 10000, sales: 1, discount: 0 },
        { country: "IN", tier: 3, tierLabel: "50% off", revenue: 9000, sales: 2, discount: 9000 },
      ]);
    });

    it("groups purchases with no recorded country at full-price tier", () => {
      addPurchase({ country: null, listPrice: 5000, amountPaid: 5000, createdAt: daysAgo(1) });

      expect(getRevenueByCountry(base.instructor.id, "30d", null, NOW)).toEqual([
        { country: null, tier: 1, tierLabel: "Full Price", revenue: 5000, sales: 1, discount: 0 },
      ]);
    });
  });

  describe("getRevenueSplit", () => {
    it("splits revenue between individual and team purchases", () => {
      addPurchase({ amountPaid: 4000, createdAt: daysAgo(1) });
      addPurchase({ amountPaid: 3000, createdAt: daysAgo(2) });
      addTeamPurchase({ amountPaid: 25000, quantity: 5, createdAt: daysAgo(3) });
      // A single-seat team purchase is still a team purchase.
      addTeamPurchase({ amountPaid: 6000, quantity: 1, createdAt: daysAgo(4) });
      addTeamPurchase({ amountPaid: 99999, quantity: 2, createdAt: daysAgo(60) });

      const split = getRevenueSplit(base.instructor.id, "30d", null, NOW);

      expect(split).toEqual({
        individual: { revenue: 7000, sales: 2, seats: 2 },
        team: { revenue: 31000, sales: 2, seats: 6 },
      });
      expect(split.individual.revenue + split.team.revenue).toBe(
        getInstructorOverview(base.instructor.id, "30d", NOW).current.revenue
      );
    });
  });

  describe("completion metrics", () => {
    it("reports the share of enrolled students who completed every lesson", () => {
      const [a, b, c, d] = addLessons(base.course.id, [2, 2]);
      addLearner({ completed: [a, b, c, d] });
      addLearner({ completed: [a, b, c] });
      addLearner({ completed: [a], inProgress: [b] });
      addLearner({ completed: [] });

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion.enrolledStudents).toBe(4);
      expect(completion.completionRate).toBe(0.25);
    });

    it("reports the average share of lessons completed per enrolled student", () => {
      const [a, b, c, d] = addLessons(base.course.id, [2, 2]);
      addLearner({ completed: [a, b, c, d] }); // 100%
      addLearner({ completed: [a], inProgress: [b] }); // 25%
      addLearner({ completed: [] }); // 0%
      addLearner({ completed: [a, b] }); // 50%

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion.averageCompletion).toBeCloseTo(0.4375);
    });

    it("pools students across the instructor's courses", () => {
      const [a] = addLessons(base.course.id, [1]);
      const other = createCourse(schema.CourseStatus.Archived);
      const [x] = addLessons(other.id, [2]);
      addLearner({ completed: [a] }); // finished, 100%
      addLearner({ courseId: other.id, completed: [x] }); // 50%

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion).toEqual({
        enrolledStudents: 2,
        completionRate: 0.5,
        averageCompletion: 0.75,
      });
    });

    it("leaves out the course's own instructor and admins", () => {
      const [a, b] = addLessons(base.course.id, [2]);
      const admin = createUser(schema.UserRole.Admin);
      addLearner({ completed: [a, b] }); // student, finished
      addLearner({ completed: [] }); // student, 0%
      addLearner({ userId: base.instructor.id, completed: [a, b] });
      addLearner({ userId: admin.id, completed: [a, b] });

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion).toEqual({
        enrolledStudents: 2,
        completionRate: 0.5,
        averageCompletion: 0.5,
      });
    });

    it("counts another instructor enrolled as a student", () => {
      const [a] = addLessons(base.course.id, [1]);
      const otherInstructor = createUser(schema.UserRole.Instructor);
      addLearner({ userId: otherInstructor.id, completed: [a] });

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion.enrolledStudents).toBe(1);
    });

    it("is all-time and ignores the selected range", () => {
      const [a] = addLessons(base.course.id, [1]);
      addLearner({ completed: [a], enrolledAt: daysAgo(400) });
      addLearner({ completed: [], enrolledAt: daysAgo(2) });

      const week = getInstructorOverview(base.instructor.id, "7d", NOW).completion;
      const all = getInstructorOverview(base.instructor.id, "all", NOW).completion;

      expect(week).toEqual({ enrolledStudents: 2, completionRate: 0.5, averageCompletion: 0.5 });
      expect(all).toEqual(week);
    });

    it("excludes draft courses", () => {
      const draft = createCourse(schema.CourseStatus.Draft);
      const [a] = addLessons(draft.id, [1]);
      addLearner({ courseId: draft.id, completed: [a] });

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion).toEqual({
        enrolledStudents: 0,
        completionRate: null,
        averageCompletion: null,
      });
    });

    it("counts students of a course with no lessons as 0% complete", () => {
      const [a] = addLessons(base.course.id, [1]);
      const empty = createCourse(schema.CourseStatus.Published);
      addLearner({ completed: [a] });
      addLearner({ courseId: empty.id });

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion).toEqual({
        enrolledStudents: 2,
        completionRate: 0.5,
        averageCompletion: 0.5,
      });
    });

    it("ignores progress on lessons from other courses", () => {
      const [a] = addLessons(base.course.id, [2]);
      const other = createCourse(schema.CourseStatus.Published);
      const [x] = addLessons(other.id, [1]);
      addLearner({ completed: [a, x] });

      const { completion } = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(completion.averageCompletion).toBe(0.5);
    });
  });

  describe("getCourseBreakdown", () => {
    it("lists one row per published or archived course with range revenue and all-time completion", () => {
      const [a, b] = addLessons(base.course.id, [2]);
      const archived = createCourse(schema.CourseStatus.Archived);
      const [x] = addLessons(archived.id, [1]);
      const draft = createCourse(schema.CourseStatus.Draft);
      addPurchase({ amountPaid: 5000, createdAt: daysAgo(2) });
      addTeamPurchase({ amountPaid: 9000, quantity: 3, createdAt: daysAgo(5) });
      addPurchase({ amountPaid: 4444, createdAt: daysAgo(60) }); // outside 30d
      addPurchase({ courseId: draft.id, amountPaid: 1000, createdAt: daysAgo(1) });
      addLearner({ completed: [a, b] });
      addLearner({ completed: [a] });
      addLearner({ completed: [] });
      addLearner({ userId: base.instructor.id, completed: [a, b] });
      addLearner({ courseId: archived.id, completed: [x] });

      const rows = getCourseBreakdown(base.instructor.id, "30d", NOW);

      expect(rows).toEqual([
        {
          courseId: base.course.id,
          title: base.course.title,
          status: schema.CourseStatus.Published,
          revenue: 14000,
          sales: 2,
          enrolledStudents: 3,
          completionRate: 1 / 3,
          averageCompletion: 0.5,
        },
        {
          courseId: archived.id,
          title: archived.title,
          status: schema.CourseStatus.Archived,
          revenue: 0,
          sales: 0,
          enrolledStudents: 1,
          completionRate: 1,
          averageCompletion: 1,
        },
      ]);
    });

    it("shows a course with no sales or students as zeros", () => {
      expect(getCourseBreakdown(base.instructor.id, "7d", NOW)).toEqual([
        expect.objectContaining({
          courseId: base.course.id,
          revenue: 0,
          sales: 0,
          enrolledStudents: 0,
          completionRate: null,
          averageCompletion: null,
        }),
      ]);
    });

    it("only lists the instructor's own courses", () => {
      const stranger = createUser(schema.UserRole.Instructor);
      createCourse(schema.CourseStatus.Published, stranger.id);

      const rows = getCourseBreakdown(base.instructor.id, "all", NOW);

      expect(rows.map((r) => r.courseId)).toEqual([base.course.id]);
    });
  });

  describe("course filtering", () => {
    it("restricts both series to the given course", () => {
      const other = createCourse(schema.CourseStatus.Published);
      addPurchase({ amountPaid: 1000, createdAt: daysAgo(1) });
      addPurchase({ courseId: other.id, amountPaid: 7000, createdAt: daysAgo(1) });
      addEnrollment({ enrolledAt: daysAgo(1) });
      addEnrollment({ courseId: other.id, enrolledAt: daysAgo(1) });
      addEnrollment({ courseId: other.id, enrolledAt: daysAgo(1) });

      const total = (points: { revenue: number }[]) =>
        points.reduce((sum, p) => sum + p.revenue, 0);
      const enrolled = (points: { enrollments: number }[]) =>
        points.reduce((sum, p) => sum + p.enrollments, 0);

      expect(total(getRevenueSeries(base.instructor.id, "7d", null, NOW).points)).toBe(8000);
      expect(total(getRevenueSeries(base.instructor.id, "7d", other.id, NOW).points)).toBe(7000);
      expect(enrolled(getEnrollmentSeries(base.instructor.id, "7d", null, NOW).points)).toBe(3);
      expect(enrolled(getEnrollmentSeries(base.instructor.id, "7d", other.id, NOW).points)).toBe(2);
    });

    it("restricts the country breakdown and team split to the given course", () => {
      const other = createCourse(schema.CourseStatus.Published);
      addPurchase({ country: "US", amountPaid: 1000, createdAt: daysAgo(1) });
      addPurchase({ courseId: other.id, country: "IN", listPrice: 4000, amountPaid: 2000, createdAt: daysAgo(1) });
      addTeamPurchase({ courseId: other.id, amountPaid: 9000, quantity: 3, createdAt: daysAgo(1) });

      expect(getRevenueByCountry(base.instructor.id, "7d", base.course.id, NOW)).toEqual([
        { country: "US", tier: 1, tierLabel: "Full Price", revenue: 1000, sales: 1, discount: 0 },
      ]);
      expect(getRevenueSplit(base.instructor.id, "7d", other.id, NOW)).toEqual({
        individual: { revenue: 2000, sales: 1, seats: 1 },
        team: { revenue: 9000, sales: 1, seats: 3 },
      });
    });

    it("returns nothing for a course the instructor does not own", () => {
      const stranger = createUser(schema.UserRole.Instructor);
      const theirs = createCourse(schema.CourseStatus.Published, stranger.id);
      addPurchase({ courseId: theirs.id, amountPaid: 7000, createdAt: daysAgo(1) });

      const points = getRevenueSeries(base.instructor.id, "7d", theirs.id, NOW).points;

      expect(points.every((p) => p.revenue === 0)).toBe(true);
    });
  });

  describe("resolveAnalyticsInstructor", () => {
    it("resolves an instructor to themselves", () => {
      expect(resolveAnalyticsInstructor(base.instructor.id, null)).toEqual({
        ok: true,
        instructor: { id: base.instructor.id, name: base.instructor.name },
      });
    });

    it("ignores another instructorId requested by an instructor", () => {
      const other = createUser(schema.UserRole.Instructor);

      expect(resolveAnalyticsInstructor(base.instructor.id, other.id)).toEqual({
        ok: true,
        instructor: { id: base.instructor.id, name: base.instructor.name },
      });
    });

    it("lets an admin view any instructor", () => {
      const admin = createUser(schema.UserRole.Admin);

      expect(resolveAnalyticsInstructor(admin.id, base.instructor.id)).toEqual({
        ok: true,
        instructor: { id: base.instructor.id, name: base.instructor.name },
      });
    });

    it("requires an admin to name an existing instructor", () => {
      const admin = createUser(schema.UserRole.Admin);

      expect(resolveAnalyticsInstructor(admin.id, null)).toEqual({
        ok: false,
        reason: "missing_instructor",
      });
      expect(resolveAnalyticsInstructor(admin.id, base.user.id)).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(resolveAnalyticsInstructor(admin.id, 99999)).toEqual({
        ok: false,
        reason: "not_found",
      });
    });

    it("rejects students and anonymous viewers", () => {
      expect(resolveAnalyticsInstructor(base.user.id, base.instructor.id)).toEqual({
        ok: false,
        reason: "forbidden",
      });
      expect(resolveAnalyticsInstructor(null, base.instructor.id)).toEqual({
        ok: false,
        reason: "unauthenticated",
      });
    });
  });

  describe("parseAnalyticsRange", () => {
    it("accepts the known presets and defaults to 30d", () => {
      expect(parseAnalyticsRange("7d")).toBe("7d");
      expect(parseAnalyticsRange("90d")).toBe("90d");
      expect(parseAnalyticsRange("all")).toBe("all");
      expect(parseAnalyticsRange(null)).toBe("30d");
      expect(parseAnalyticsRange("365d")).toBe("30d");
    });
  });
});
