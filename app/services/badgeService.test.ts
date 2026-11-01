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

// Import after mock so the modules pick up our test db
import {
  evaluateBadgesForLesson,
  evaluateBadgesForUser,
  getUserBadges,
  hasUnseenBadges,
  markBadgesSeen,
} from "./badgeService";
import { findEnrollment } from "./enrollmentService";
import { resetLessonProgress } from "./progressService";

function createModuleWithLessons(courseId: number, lessonCount: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module 1", position: 1 })
    .returning()
    .get();

  return Array.from({ length: lessonCount }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function completeLesson(userId: number, lessonId: number, completedAt: string) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt,
    })
    .run();
}

describe("badgeService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    testDb
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
  });

  describe("course completed", () => {
    it("awards the badge when every lesson of the course is completed, dated when the last one was", () => {
      const lessons = createModuleWithLessons(base.course.id, 2);
      completeLesson(base.user.id, lessons[0].id, "2026-01-01T10:00:00.000Z");
      completeLesson(base.user.id, lessons[1].id, "2026-01-03T10:00:00.000Z");

      const awarded = evaluateBadgesForLesson(base.user.id, lessons[1].id);

      expect(awarded).toEqual([
        expect.objectContaining({
          type: schema.BadgeType.CourseCompleted,
          courseId: base.course.id,
          title: "Test Course",
          awardedAt: "2026-01-03T10:00:00.000Z",
          seenAt: null,
        }),
      ]);
      expect(getUserBadges(base.user.id)).toHaveLength(1);
    });

    it("does not award the badge while any lesson is incomplete", () => {
      const lessons = createModuleWithLessons(base.course.id, 2);
      completeLesson(base.user.id, lessons[0].id, "2026-01-01T10:00:00.000Z");

      expect(evaluateBadgesForLesson(base.user.id, lessons[0].id)).toEqual([]);
      expect(getUserBadges(base.user.id)).toEqual([]);
      expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBeNull();
    });

    it("does not count duplicate progress rows for one lesson as extra completed lessons", () => {
      const lessons = createModuleWithLessons(base.course.id, 2);
      completeLesson(base.user.id, lessons[0].id, "2026-01-01T10:00:00.000Z");
      completeLesson(base.user.id, lessons[0].id, "2026-01-02T10:00:00.000Z");

      expect(evaluateBadgesForLesson(base.user.id, lessons[0].id)).toEqual([]);
    });

    it("marks the enrollment complete on the date the course was completed", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      completeLesson(base.user.id, lessons[0].id, "2026-01-03T10:00:00.000Z");

      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBe(
        "2026-01-03T10:00:00.000Z"
      );
    });

    it("does not award the badge twice when evaluated repeatedly", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      completeLesson(base.user.id, lessons[0].id, "2026-01-03T10:00:00.000Z");

      evaluateBadgesForLesson(base.user.id, lessons[0].id);
      const second = evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(second).toEqual([]);
      expect(getUserBadges(base.user.id)).toHaveLength(1);
    });

    it("keeps the badge after the user's progress is reset", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      completeLesson(base.user.id, lessons[0].id, "2026-01-03T10:00:00.000Z");
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      resetLessonProgress(base.user.id, lessons[0].id);
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(getUserBadges(base.user.id)).toHaveLength(1);
    });

    it("keeps the badge after lessons are added to the course", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      completeLesson(base.user.id, lessons[0].id, "2026-01-03T10:00:00.000Z");
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      createModuleWithLessons(base.course.id, 2);
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(getUserBadges(base.user.id)).toEqual([
        expect.objectContaining({ courseId: base.course.id, title: "Test Course" }),
      ]);
    });
  });

  describe("evaluateBadgesForUser", () => {
    it("awards badges for every course the user has completed, with historical dates", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      completeLesson(base.user.id, lessons[0].id, "2025-06-01T10:00:00.000Z");

      const awarded = evaluateBadgesForUser(base.user.id);

      expect(awarded).toEqual([
        expect.objectContaining({
          courseId: base.course.id,
          awardedAt: "2025-06-01T10:00:00.000Z",
        }),
      ]);
      expect(evaluateBadgesForUser(base.user.id)).toEqual([]);
    });
  });

  describe("seen tracking", () => {
    it("reports new badges as unseen until they are marked seen", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      completeLesson(base.user.id, lessons[0].id, "2026-01-03T10:00:00.000Z");

      expect(hasUnseenBadges(base.user.id)).toBe(false);

      evaluateBadgesForLesson(base.user.id, lessons[0].id);
      expect(hasUnseenBadges(base.user.id)).toBe(true);

      markBadgesSeen(base.user.id);
      expect(hasUnseenBadges(base.user.id)).toBe(false);
      expect(getUserBadges(base.user.id)[0].seenAt).not.toBeNull();
    });

    it("only marks the given user's badges as seen", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      completeLesson(base.user.id, lessons[0].id, "2026-01-03T10:00:00.000Z");
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      markBadgesSeen(base.instructor.id);

      expect(hasUnseenBadges(base.user.id)).toBe(true);
    });
  });
});
