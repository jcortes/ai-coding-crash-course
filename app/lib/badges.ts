import { Trophy, type LucideIcon } from "lucide-react";
import { BadgeType } from "~/db/schema";

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
};

export function badgeLabel(badge: { type: BadgeType; title: string }) {
  return `${BADGE_CATALOG[badge.type].name}: ${badge.title}`;
}
