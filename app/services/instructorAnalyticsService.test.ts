import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getInstructorOverview,
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
      country: "US",
      createdAt: opts.createdAt,
    })
    .returning()
    .get();
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
