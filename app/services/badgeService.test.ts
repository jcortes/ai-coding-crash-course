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
  backfillBadges,
  evaluateBadgesForLesson,
  evaluateBadgesForUser,
  getCourseBadgesByStudent,
  getMasteredModuleIds,
  getStreakSummary,
  getUserBadges,
  hasUnseenBadges,
  markBadgesSeen,
} from "./badgeService";
import { findEnrollment } from "./enrollmentService";
import { resetLessonProgress } from "./progressService";

function createModuleWithLessons(
  courseId: number,
  lessonCount: number,
  title = "Module 1"
) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title, position: 1 })
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

function addQuiz(lessonId: number) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
}

function attemptQuiz(
  userId: number,
  quizId: number,
  attemptedAt: string,
  passed = true
) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score: passed ? 1 : 0, passed, attemptedAt })
    .run();
}

// Completes the lesson and passes its quiz at the same moment, so it counts
// towards the streak on that UTC day.
function finishQuizLesson(userId: number, lessonId: number, at: string) {
  const quiz = addQuiz(lessonId);
  completeLesson(userId, lessonId, at);
  attemptQuiz(userId, quiz.id, at);
}

// Finishes two quiz lessons on each given UTC day ("2026-01-01", ...),
// using fresh lessons each day. Returns the last lesson finished.
function finishStreakDays(userId: number, days: string[]) {
  const lessons = createModuleWithLessons(base.course.id, days.length * 2);
  days.forEach((day, i) => {
    finishQuizLesson(userId, lessons[i * 2].id, `${day}T09:00:00.000Z`);
    finishQuizLesson(userId, lessons[i * 2 + 1].id, `${day}T18:00:00.000Z`);
  });
  return lessons[lessons.length - 1];
}

function streakLevels(userId: number) {
  return badgesOfType(userId, schema.BadgeType.Streak)
    .map((b) => b.level)
    .sort((a, b) => a! - b!);
}

function badgesOfType(userId: number, type: schema.BadgeType) {
  return getUserBadges(userId).filter((b) => b.type === type);
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

  describe("module mastered", () => {
    it("awards the badge once every lesson with a quiz in the module has a passed attempt, dated at the last pass", () => {
      const lessons = createModuleWithLessons(base.course.id, 3, "Basics");
      const quizA = addQuiz(lessons[0].id);
      const quizB = addQuiz(lessons[1].id);
      // lessons[2] has no quiz and is not required.
      attemptQuiz(base.user.id, quizA.id, "2026-01-01T10:00:00.000Z");
      attemptQuiz(base.user.id, quizB.id, "2026-01-02T10:00:00.000Z", false);

      expect(evaluateBadgesForLesson(base.user.id, lessons[1].id)).toEqual([]);

      attemptQuiz(base.user.id, quizB.id, "2026-01-04T10:00:00.000Z");
      attemptQuiz(base.user.id, quizB.id, "2026-01-05T10:00:00.000Z");

      expect(evaluateBadgesForLesson(base.user.id, lessons[1].id)).toEqual([
        expect.objectContaining({
          type: schema.BadgeType.ModuleMastered,
          courseId: base.course.id,
          moduleId: lessons[0].moduleId,
          title: "Basics",
          awardedAt: "2026-01-04T10:00:00.000Z",
        }),
      ]);
    });

    it("reports which of the course's modules the user has mastered", () => {
      const mastered = createModuleWithLessons(base.course.id, 1);
      const pending = createModuleWithLessons(base.course.id, 1);
      attemptQuiz(base.user.id, addQuiz(mastered[0].id).id, "2026-01-01T10:00:00.000Z");
      addQuiz(pending[0].id);
      evaluateBadgesForLesson(base.user.id, mastered[0].id);

      expect(getMasteredModuleIds(base.user.id, base.course.id)).toEqual(
        new Set([mastered[0].moduleId])
      );
    });

    it("does not award a badge for a module without quizzes", () => {
      const lessons = createModuleWithLessons(base.course.id, 2);
      completeLesson(base.user.id, lessons[0].id, "2026-01-01T10:00:00.000Z");

      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(badgesOfType(base.user.id, schema.BadgeType.ModuleMastered)).toEqual([]);
    });

    it("keeps the badge after a quiz is added to the module", () => {
      const lessons = createModuleWithLessons(base.course.id, 2);
      const quiz = addQuiz(lessons[0].id);
      attemptQuiz(base.user.id, quiz.id, "2026-01-01T10:00:00.000Z");
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      addQuiz(lessons[1].id);
      const again = evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(again).toEqual([]);
      expect(badgesOfType(base.user.id, schema.BadgeType.ModuleMastered)).toHaveLength(1);
    });

    it("does not award the badge twice when evaluated repeatedly", () => {
      const lessons = createModuleWithLessons(base.course.id, 1);
      const quiz = addQuiz(lessons[0].id);
      attemptQuiz(base.user.id, quiz.id, "2026-01-01T10:00:00.000Z");

      evaluateBadgesForLesson(base.user.id, lessons[0].id);
      attemptQuiz(base.user.id, quiz.id, "2026-01-02T10:00:00.000Z");
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(badgesOfType(base.user.id, schema.BadgeType.ModuleMastered)).toHaveLength(1);
    });
  });

  describe("streak", () => {
    it("awards the 3-day badge after three consecutive UTC days with two quiz lessons each, dated at the second lesson of day three", () => {
      const last = finishStreakDays(base.user.id, [
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
      ]);

      expect(evaluateBadgesForLesson(base.user.id, last.id)).toContainEqual(
        expect.objectContaining({
          type: schema.BadgeType.Streak,
          level: 3,
          title: "3-day streak",
          awardedAt: "2026-01-03T18:00:00.000Z",
          courseId: null,
        })
      );
    });

    it("awards the 7- and 15-day badges as a longer run reaches them", () => {
      const days = Array.from(
        { length: 15 },
        (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`
      );
      const last = finishStreakDays(base.user.id, days);

      evaluateBadgesForLesson(base.user.id, last.id);

      expect(
        badgesOfType(base.user.id, schema.BadgeType.Streak).map((b) => [
          b.level,
          b.awardedAt,
        ])
      ).toEqual(
        expect.arrayContaining([
          [3, "2026-01-03T18:00:00.000Z"],
          [7, "2026-01-07T18:00:00.000Z"],
          [15, "2026-01-15T18:00:00.000Z"],
        ])
      );
      expect(streakLevels(base.user.id)).toEqual([3, 7, 15]);
    });

    it("splits days at midnight UTC", () => {
      const lessons = createModuleWithLessons(base.course.id, 6);
      // Each pair straddles midnight UTC, so no single day reaches two lessons.
      finishQuizLesson(base.user.id, lessons[0].id, "2026-01-01T23:30:00.000Z");
      finishQuizLesson(base.user.id, lessons[1].id, "2026-01-02T00:30:00.000Z");
      finishQuizLesson(base.user.id, lessons[2].id, "2026-01-02T23:59:59.000Z");
      finishQuizLesson(base.user.id, lessons[3].id, "2026-01-03T00:00:00.000Z");
      finishQuizLesson(base.user.id, lessons[4].id, "2026-01-03T23:59:59.000Z");

      evaluateBadgesForLesson(base.user.id, lessons[4].id);
      expect(streakLevels(base.user.id)).toEqual([]);

      // 2026-01-01 23:30 and a second lesson at 23:59 on the same day qualify it.
      finishQuizLesson(base.user.id, lessons[5].id, "2026-01-01T23:59:00.000Z");
      evaluateBadgesForLesson(base.user.id, lessons[5].id);
      expect(streakLevels(base.user.id)).toEqual([3]);
    });

    it("does not join days that are not consecutive", () => {
      const last = finishStreakDays(base.user.id, [
        "2026-01-01",
        "2026-01-02",
        "2026-01-04",
        "2026-01-05",
      ]);

      evaluateBadgesForLesson(base.user.id, last.id);

      expect(streakLevels(base.user.id)).toEqual([]);
    });

    it("does not count lessons without a quiz", () => {
      const days = ["2026-01-01", "2026-01-02", "2026-01-03"];
      const lessons = createModuleWithLessons(base.course.id, 6);
      days.forEach((day, i) => {
        finishQuizLesson(base.user.id, lessons[i * 2].id, `${day}T09:00:00.000Z`);
        // The day's second lesson has no quiz.
        completeLesson(base.user.id, lessons[i * 2 + 1].id, `${day}T18:00:00.000Z`);
      });

      evaluateBadgesForLesson(base.user.id, lessons[5].id);

      expect(streakLevels(base.user.id)).toEqual([]);
    });

    it("counts each lesson once, so passing a quiz again does not add to the day", () => {
      finishStreakDays(base.user.id, ["2026-01-01", "2026-01-02"]);
      const lessons = createModuleWithLessons(base.course.id, 2);
      // A spare lesson keeps day one qualifying whatever happens to the retaken one.
      finishQuizLesson(base.user.id, lessons[0].id, "2026-01-01T20:00:00.000Z");
      // Day three: one new lesson plus a retake of a quiz already passed on day one.
      finishQuizLesson(base.user.id, lessons[1].id, "2026-01-03T09:00:00.000Z");
      const firstDayQuiz = testDb
        .select()
        .from(schema.quizzes)
        .orderBy(schema.quizzes.id)
        .get()!;
      attemptQuiz(base.user.id, firstDayQuiz.id, "2026-01-03T18:00:00.000Z");

      evaluateBadgesForLesson(base.user.id, lessons[1].id);

      expect(streakLevels(base.user.id)).toEqual([]);
    });

    it("counts a lesson on the day of the later of completing it and passing its quiz", () => {
      finishStreakDays(base.user.id, ["2026-01-01", "2026-01-02"]);
      const lessons = createModuleWithLessons(base.course.id, 2);
      // Lesson A: completed on day one, passed on day three.
      const quizA = addQuiz(lessons[0].id);
      completeLesson(base.user.id, lessons[0].id, "2026-01-01T12:00:00.000Z");
      attemptQuiz(base.user.id, quizA.id, "2026-01-03T10:00:00.000Z");
      // Lesson B: passed on day one, completed on day three.
      const quizB = addQuiz(lessons[1].id);
      attemptQuiz(base.user.id, quizB.id, "2026-01-01T12:00:00.000Z");
      completeLesson(base.user.id, lessons[1].id, "2026-01-03T11:00:00.000Z");

      expect(evaluateBadgesForLesson(base.user.id, lessons[1].id)).toContainEqual(
        expect.objectContaining({ level: 3, awardedAt: "2026-01-03T11:00:00.000Z" })
      );
    });

    it("does not count a passed quiz whose lesson is not marked complete", () => {
      finishStreakDays(base.user.id, ["2026-01-01", "2026-01-02"]);
      const lessons = createModuleWithLessons(base.course.id, 2);
      finishQuizLesson(base.user.id, lessons[0].id, "2026-01-03T09:00:00.000Z");
      const quiz = addQuiz(lessons[1].id);
      attemptQuiz(base.user.id, quiz.id, "2026-01-03T10:00:00.000Z");

      evaluateBadgesForLesson(base.user.id, lessons[1].id);

      expect(streakLevels(base.user.id)).toEqual([]);
    });

    it("keeps an earned level after the streak breaks", () => {
      const lessons = createModuleWithLessons(base.course.id, 7);
      finishStreakDays(base.user.id, ["2026-01-01", "2026-01-02", "2026-01-03"]);
      evaluateBadgesForLesson(base.user.id, lessons[0].id);
      expect(streakLevels(base.user.id)).toEqual([3]);

      // After a missed day, a lone lesson counts but the run is broken.
      finishQuizLesson(base.user.id, lessons[0].id, "2026-01-05T10:00:00.000Z");
      evaluateBadgesForLesson(base.user.id, lessons[0].id);

      expect(getStreakSummary(base.user.id, new Date("2026-01-05T12:00:00.000Z")))
        .toEqual({ currentStreak: 0, lessonsToday: 1 });
      expect(streakLevels(base.user.id)).toEqual([3]);
    });

    it("does not award a level again when a later run reaches it", () => {
      const last = finishStreakDays(base.user.id, [
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        // gap on 2026-01-04
        "2026-01-05",
        "2026-01-06",
        "2026-01-07",
      ]);

      evaluateBadgesForLesson(base.user.id, last.id);

      expect(badgesOfType(base.user.id, schema.BadgeType.Streak)).toEqual([
        expect.objectContaining({ level: 3, awardedAt: "2026-01-03T18:00:00.000Z" }),
      ]);
    });
  });

  describe("getStreakSummary", () => {
    const now = new Date("2026-01-05T15:00:00.000Z");

    it("keeps yesterday's streak active while today is still in progress", () => {
      finishStreakDays(base.user.id, ["2026-01-03", "2026-01-04"]);
      const [today] = createModuleWithLessons(base.course.id, 1);
      finishQuizLesson(base.user.id, today.id, "2026-01-05T08:00:00.000Z");

      expect(getStreakSummary(base.user.id, now)).toEqual({
        currentStreak: 2,
        lessonsToday: 1,
      });
    });

    it("includes today once it reaches the daily goal", () => {
      finishStreakDays(base.user.id, ["2026-01-04", "2026-01-05"]);

      expect(getStreakSummary(base.user.id, now)).toEqual({
        currentStreak: 2,
        lessonsToday: 2,
      });
    });

    it("is zero when neither today nor yesterday met the goal", () => {
      finishStreakDays(base.user.id, ["2026-01-02", "2026-01-03"]);

      expect(getStreakSummary(base.user.id, now)).toEqual({
        currentStreak: 0,
        lessonsToday: 0,
      });
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

    it("also awards module and streak badges from historical data, idempotently", () => {
      finishStreakDays(base.user.id, ["2025-06-01", "2025-06-02", "2025-06-03"]);

      const awarded = evaluateBadgesForUser(base.user.id);

      expect(awarded).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: schema.BadgeType.CourseCompleted,
            awardedAt: "2025-06-03T18:00:00.000Z",
          }),
          expect.objectContaining({
            type: schema.BadgeType.ModuleMastered,
            awardedAt: "2025-06-03T18:00:00.000Z",
          }),
          expect.objectContaining({
            type: schema.BadgeType.Streak,
            level: 3,
            awardedAt: "2025-06-03T18:00:00.000Z",
          }),
        ])
      );
      expect(awarded).toHaveLength(3);
      expect(evaluateBadgesForUser(base.user.id)).toEqual([]);
    });
  });

  describe("backfillBadges", () => {
    function createStudent(email: string) {
      const student = testDb
        .insert(schema.users)
        .values({ name: email, email, role: schema.UserRole.Student })
        .returning()
        .get();
      testDb
        .insert(schema.enrollments)
        .values({ userId: student.id, courseId: base.course.id })
        .run();
      return student;
    }

    function allBadges() {
      return testDb.select().from(schema.userBadges).all();
    }

    it("awards every user's earned badges with the historical dates, unseen", () => {
      const other = createStudent("other@example.com");
      const [lesson] = createModuleWithLessons(base.course.id, 1);
      const quiz = addQuiz(lesson.id);
      completeLesson(base.user.id, lesson.id, "2025-03-01T10:00:00.000Z");
      attemptQuiz(base.user.id, quiz.id, "2025-03-02T11:00:00.000Z");
      completeLesson(other.id, lesson.id, "2025-04-05T08:00:00.000Z");

      const result = backfillBadges();

      expect(result).toEqual({ userCount: 3, badgesAwarded: 3 });
      expect(
        allBadges()
          .map((b) => [b.userId, b.type, b.awardedAt, b.seenAt])
          .sort()
      ).toEqual(
        [
          [base.user.id, schema.BadgeType.CourseCompleted, "2025-03-01T10:00:00.000Z", null],
          [base.user.id, schema.BadgeType.ModuleMastered, "2025-03-02T11:00:00.000Z", null],
          [other.id, schema.BadgeType.CourseCompleted, "2025-04-05T08:00:00.000Z", null],
        ].sort()
      );
    });

    it("fills enrollments.completedAt for finished courses with the historical date", () => {
      const other = createStudent("other@example.com");
      const lessons = createModuleWithLessons(base.course.id, 2);
      completeLesson(base.user.id, lessons[0].id, "2025-03-01T10:00:00.000Z");
      completeLesson(base.user.id, lessons[1].id, "2025-03-04T10:00:00.000Z");
      completeLesson(other.id, lessons[0].id, "2025-03-01T10:00:00.000Z");

      backfillBadges();

      expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBe(
        "2025-03-04T10:00:00.000Z"
      );
      expect(findEnrollment(other.id, base.course.id)?.completedAt).toBeNull();
    });

    it("dates course completion by each lesson's first completion, ignoring later duplicate rows", () => {
      const lessons = createModuleWithLessons(base.course.id, 2);
      completeLesson(base.user.id, lessons[0].id, "2025-03-01T10:00:00.000Z");
      completeLesson(base.user.id, lessons[1].id, "2025-03-02T10:00:00.000Z");
      completeLesson(base.user.id, lessons[0].id, "2025-05-01T10:00:00.000Z");

      backfillBadges();

      expect(allBadges()[0].awardedAt).toBe("2025-03-02T10:00:00.000Z");
      expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBe(
        "2025-03-02T10:00:00.000Z"
      );
    });

    it("is idempotent: re-running creates no duplicates and keeps dates and seen state", () => {
      finishStreakDays(base.user.id, ["2025-06-01", "2025-06-02", "2025-06-03"]);
      backfillBadges();
      markBadgesSeen(base.user.id);
      const before = allBadges();
      const enrollmentBefore = findEnrollment(base.user.id, base.course.id);

      const result = backfillBadges();

      expect(result.badgesAwarded).toBe(0);
      expect(allBadges()).toEqual(before);
      expect(findEnrollment(base.user.id, base.course.id)).toEqual(
        enrollmentBefore
      );
    });

    it("only adds badges earned since the previous run", () => {
      const lessons = createModuleWithLessons(base.course.id, 2);
      completeLesson(base.user.id, lessons[0].id, "2025-03-01T10:00:00.000Z");
      backfillBadges();
      expect(allBadges()).toHaveLength(0);

      completeLesson(base.user.id, lessons[1].id, "2025-03-05T10:00:00.000Z");
      const result = backfillBadges();

      expect(result.badgesAwarded).toBe(1);
      expect(allBadges()[0].awardedAt).toBe("2025-03-05T10:00:00.000Z");
    });
  });

  describe("getCourseBadgesByStudent", () => {
    it("lists each student's course and module badges for that course, without streaks or other courses", () => {
      finishStreakDays(base.user.id, ["2026-01-01", "2026-01-02", "2026-01-03"]);
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other Course",
          slug: "other-course",
          description: "Other",
          salesCopy: "Sales copy",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      testDb
        .insert(schema.enrollments)
        .values({ userId: base.user.id, courseId: otherCourse.id })
        .run();
      const [otherLesson] = createModuleWithLessons(otherCourse.id, 1);
      completeLesson(base.user.id, otherLesson.id, "2026-01-04T10:00:00.000Z");
      evaluateBadgesForUser(base.user.id);

      const byStudent = getCourseBadgesByStudent(base.course.id);

      expect(
        byStudent.get(base.user.id)?.map((b) => [b.type, b.title])
      ).toEqual(
        expect.arrayContaining([
          [schema.BadgeType.CourseCompleted, "Test Course"],
          [schema.BadgeType.ModuleMastered, "Module 1"],
        ])
      );
      expect(byStudent.get(base.user.id)).toHaveLength(2);
      expect(byStudent.get(base.instructor.id)).toBeUndefined();
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
