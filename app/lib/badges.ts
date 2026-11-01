import { Flame, Medal, Trophy, type LucideIcon } from "lucide-react";
import { BadgeType } from "~/db/schema";

// A streak day needs this many lessons with a quiz, each completed and passed.
export const STREAK_DAILY_GOAL = 2;
export const STREAK_LEVELS = [3, 7, 15] as const;

// Badge catalog: display data for each badge type. Award rules live in
// ~/services/badgeService.
export const BADGE_CATALOG: Record<
  BadgeType,
  { name: string; icon: LucideIcon; description: string }
> = {
  [BadgeType.CourseCompleted]: {
    name: "Course completed",
    icon: Trophy,
    description: "Completed every lesson of a course.",
  },
  [BadgeType.ModuleMastered]: {
    name: "Module mastered",
    icon: Medal,
    description: "Passed the quiz of every lesson in a module.",
  },
  [BadgeType.Streak]: {
    name: "Streak",
    icon: Flame,
    description: `Completed ${STREAK_DAILY_GOAL} lessons with a quiz every day, several days in a row.`,
  },
};

export function streakTitle(level: number) {
  return `${level}-day streak`;
}

export function badgeLabel(badge: { type: BadgeType; title: string }) {
  return `${BADGE_CATALOG[badge.type].name}: ${badge.title}`;
}
