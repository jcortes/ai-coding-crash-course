import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  BadgeType,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  userBadges,
} from "~/db/schema";
import {
  findEnrollment,
  getEnrollmentsByUser,
  markEnrollmentComplete,
} from "~/services/enrollmentService";
import { getCourseById } from "~/services/courseService";

// ─── Badge Service ───
// Awards achievement badges and tracks which ones the user has seen.
// Badges are permanent: once inserted they are never removed or re-evaluated.
// The catalog (name, icon, description) lives in ~/lib/badges.
// Uses positional parameters (project convention).

export type UserBadge = typeof userBadges.$inferSelect;

function insertBadge(badge: typeof userBadges.$inferInsert) {
  // The per-type unique indexes turn a repeat award into a no-op, so callers
  // can evaluate as often as they like.
  return db.insert(userBadges).values(badge).onConflictDoNothing().returning().get();
}

// The date the user completed the last lesson of the course, or null if any
// lesson is still incomplete. Same criterion as the course progress bar.
function getCourseCompletionDate(userId: number, courseId: number) {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((l) => l.id);

  if (lessonIds.length === 0) return null;

  const completed = db
    .select({
      lessonId: lessonProgress.lessonId,
      completedAt: lessonProgress.completedAt,
    })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .all();

  // lesson_progress has no unique (user, lesson) key, so count distinct lessons.
  const completedLessonIds = new Set(completed.map((p) => p.lessonId));
  if (completedLessonIds.size < lessonIds.length) return null;

  const latest = completed.reduce<string | null>(
    (latest, p) =>
      p.completedAt && (!latest || p.completedAt > latest)
        ? p.completedAt
        : latest,
    null
  );
  // Rows without a completion date still count; date the award now.
  return latest ?? new Date().toISOString();
}

export function evaluateCourseCompletion(userId: number, courseId: number) {
  const completedAt = getCourseCompletionDate(userId, courseId);
  if (!completedAt) return [];

  const enrollment = findEnrollment(userId, courseId);
  if (enrollment && !enrollment.completedAt) {
    markEnrollmentComplete(userId, courseId, completedAt);
  }

  const course = getCourseById(courseId);
  if (!course) return [];

  const badge = insertBadge({
    userId,
    type: BadgeType.CourseCompleted,
    courseId,
    title: course.title,
    awardedAt: completedAt,
  });

  return badge ? [badge] : [];
}

// Hook point for live awarding: call after the user's progress on a lesson
// changes. Returns only the badges awarded by this call.
export function evaluateBadgesForLesson(userId: number, lessonId: number) {
  const lesson = db
    .select({ courseId: modules.courseId })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(lessons.id, lessonId))
    .get();
  if (!lesson) return [];

  return evaluateCourseCompletion(userId, lesson.courseId);
}

// Evaluates every badge the user may have earned from their existing data.
// Idempotent and uses historical dates, so seeding and backfills can reuse it.
export function evaluateBadgesForUser(userId: number) {
  return getEnrollmentsByUser(userId).flatMap((enrollment) =>
    evaluateCourseCompletion(userId, enrollment.courseId)
  );
}

export function getUserBadges(userId: number) {
  return db
    .select()
    .from(userBadges)
    .where(eq(userBadges.userId, userId))
    .orderBy(desc(userBadges.awardedAt))
    .all();
}

export function hasUnseenBadges(userId: number) {
  return !!db
    .select({ id: userBadges.id })
    .from(userBadges)
    .where(and(eq(userBadges.userId, userId), isNull(userBadges.seenAt)))
    .get();
}

export function markBadgesSeen(userId: number) {
  db.update(userBadges)
    .set({ seenAt: new Date().toISOString() })
    .where(and(eq(userBadges.userId, userId), isNull(userBadges.seenAt)))
    .run();
}
