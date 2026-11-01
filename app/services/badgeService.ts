import { eq, and, desc, inArray, isNull, min } from "drizzle-orm";
import { db } from "~/db";
import {
  BadgeType,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  quizAttempts,
  quizzes,
  userBadges,
} from "~/db/schema";
import {
  findEnrollment,
  getEnrollmentsByUser,
  markEnrollmentComplete,
} from "~/services/enrollmentService";
import { getCourseById } from "~/services/courseService";
import { getModuleById, getModulesByCourse } from "~/services/moduleService";
import { getLessonsByModule } from "~/services/lessonService";
import { STREAK_DAILY_GOAL, STREAK_LEVELS, streakTitle } from "~/lib/badges";

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

// Among the given lessons: which have a quiz, and when the user first passed
// each one (lessons never passed are absent from firstPass).
function getFirstPassDates(userId: number, lessonIds: number[]) {
  const quizLessonIds = new Set<number>();
  const firstPass = new Map<number, string>();
  if (lessonIds.length === 0) return { quizLessonIds, firstPass };

  for (const q of db
    .select({ lessonId: quizzes.lessonId })
    .from(quizzes)
    .where(inArray(quizzes.lessonId, lessonIds))
    .all()) {
    quizLessonIds.add(q.lessonId);
  }

  const passes = db
    .select({
      lessonId: quizzes.lessonId,
      passedAt: min(quizAttempts.attemptedAt),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .where(
      and(
        eq(quizAttempts.userId, userId),
        eq(quizAttempts.passed, true),
        inArray(quizzes.lessonId, lessonIds)
      )
    )
    .groupBy(quizzes.lessonId)
    .all();
  for (const p of passes) {
    if (p.passedAt) firstPass.set(p.lessonId, p.passedAt);
  }

  return { quizLessonIds, firstPass };
}

// A module is mastered when every lesson in it that has a quiz has a passed
// attempt. Dated at the pass that completed the set. Modules without quizzes
// never award a badge.
export function evaluateModuleMastery(userId: number, moduleId: number) {
  const mod = getModuleById(moduleId);
  if (!mod) return [];

  const lessonIds = getLessonsByModule(moduleId).map((l) => l.id);

  const { quizLessonIds, firstPass } = getFirstPassDates(userId, lessonIds);
  if (quizLessonIds.size === 0) return [];

  let masteredAt = "";
  for (const lessonId of quizLessonIds) {
    const passedAt = firstPass.get(lessonId);
    if (!passedAt) return [];
    if (passedAt > masteredAt) masteredAt = passedAt;
  }

  const badge = insertBadge({
    userId,
    type: BadgeType.ModuleMastered,
    courseId: mod.courseId,
    moduleId,
    title: mod.title,
    awardedAt: masteredAt,
  });

  return badge ? [badge] : [];
}

// ─── Streaks ───
// A lesson counts towards the streak once, on the UTC day when the later of
// "marked complete" and "quiz first passed" happened. Lessons without a quiz
// never count, and passing an already-passed quiz again changes nothing.

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

function previousUtcDay(day: string) {
  return utcDay(new Date(Date.parse(day) - DAY_MS).toISOString());
}

// When each of the user's lessons started counting, oldest first.
function getStreakLessonDates(userId: number) {
  const completedAt = new Map<number, string>();
  for (const p of db
    .select({
      lessonId: lessonProgress.lessonId,
      completedAt: lessonProgress.completedAt,
    })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .all()) {
    if (!p.completedAt) continue;
    // lesson_progress has no unique (user, lesson) key; the first completion wins.
    const existing = completedAt.get(p.lessonId);
    if (!existing || p.completedAt < existing) {
      completedAt.set(p.lessonId, p.completedAt);
    }
  }

  const { firstPass } = getFirstPassDates(userId, [...completedAt.keys()]);

  const dates: string[] = [];
  for (const [lessonId, passedAt] of firstPass) {
    const done = completedAt.get(lessonId)!;
    dates.push(done > passedAt ? done : passedAt);
  }
  return dates.sort();
}

// UTC days that met the daily goal, oldest first, each with the moment it did.
function getStreakDays(lessonDates: string[]) {
  const byDay = new Map<string, string[]>();
  for (const at of lessonDates) {
    const day = utcDay(at);
    byDay.set(day, [...(byDay.get(day) ?? []), at]);
  }

  return [...byDay]
    .filter(([, times]) => times.length >= STREAK_DAILY_GOAL)
    .map(([day, times]) => ({ day, reachedAt: times[STREAK_DAILY_GOAL - 1] }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// Each level is awarded once, dated when a run of consecutive days first
// reached it. Badges stay when the streak later breaks.
export function evaluateStreaks(userId: number) {
  const awarded: UserBadge[] = [];
  let run = 0;
  let prevDay: string | null = null;

  for (const { day, reachedAt } of getStreakDays(getStreakLessonDates(userId))) {
    run = prevDay && previousUtcDay(day) === prevDay ? run + 1 : 1;
    prevDay = day;

    const level = STREAK_LEVELS.find((l) => l === run);
    if (!level) continue;

    const badge = insertBadge({
      userId,
      type: BadgeType.Streak,
      level,
      title: streakTitle(level),
      awardedAt: reachedAt,
    });
    if (badge) awarded.push(badge);
  }

  return awarded;
}

// The run of consecutive goal days ending today, or ending yesterday while
// today is still in progress, plus how many lessons have counted today.
export function getStreakSummary(userId: number, now: Date = new Date()) {
  const lessonDates = getStreakLessonDates(userId);
  const goalDays = new Set(getStreakDays(lessonDates).map((d) => d.day));

  const today = utcDay(now.toISOString());
  let day = goalDays.has(today) ? today : previousUtcDay(today);
  let currentStreak = 0;
  while (goalDays.has(day)) {
    currentStreak++;
    day = previousUtcDay(day);
  }

  const lessonsToday = lessonDates.filter((at) => utcDay(at) === today).length;
  return { currentStreak, lessonsToday };
}

// Hook point for live awarding: call after the user's progress on a lesson
// changes. Returns only the badges awarded by this call.
export function evaluateBadgesForLesson(userId: number, lessonId: number) {
  const lesson = db
    .select({ courseId: modules.courseId, moduleId: lessons.moduleId })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(lessons.id, lessonId))
    .get();
  if (!lesson) return [];

  return [
    ...evaluateCourseCompletion(userId, lesson.courseId),
    ...evaluateModuleMastery(userId, lesson.moduleId),
    ...evaluateStreaks(userId),
  ];
}

// Evaluates every badge the user may have earned from their existing data.
// Idempotent and uses historical dates, so seeding and backfills can reuse it.
export function evaluateBadgesForUser(userId: number) {
  const perCourse = getEnrollmentsByUser(userId).flatMap((enrollment) => {
    const courseModules = getModulesByCourse(enrollment.courseId);
    return [
      ...evaluateCourseCompletion(userId, enrollment.courseId),
      ...courseModules.flatMap((m) => evaluateModuleMastery(userId, m.id)),
    ];
  });
  return [...perCourse, ...evaluateStreaks(userId)];
}

export function getUserBadges(userId: number) {
  return db
    .select()
    .from(userBadges)
    .where(eq(userBadges.userId, userId))
    .orderBy(desc(userBadges.awardedAt))
    .all();
}

// Course and module badges earned in one course, keyed by student, for the
// instructor's roster. Streaks are global to the user and are left out.
export function getCourseBadgesByStudent(courseId: number) {
  const badges = db
    .select()
    .from(userBadges)
    .where(
      and(
        eq(userBadges.courseId, courseId),
        inArray(userBadges.type, [
          BadgeType.CourseCompleted,
          BadgeType.ModuleMastered,
        ])
      )
    )
    .orderBy(userBadges.awardedAt)
    .all();

  const byStudent = new Map<number, UserBadge[]>();
  for (const badge of badges) {
    byStudent.set(badge.userId, [...(byStudent.get(badge.userId) ?? []), badge]);
  }
  return byStudent;
}

// Ids of the modules in a course the user has a mastery badge for.
export function getMasteredModuleIds(userId: number, courseId: number) {
  return new Set(
    db
      .select({ moduleId: userBadges.moduleId })
      .from(userBadges)
      .where(
        and(
          eq(userBadges.userId, userId),
          eq(userBadges.courseId, courseId),
          eq(userBadges.type, BadgeType.ModuleMastered)
        )
      )
      .all()
      .map((b) => b.moduleId!)
  );
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
