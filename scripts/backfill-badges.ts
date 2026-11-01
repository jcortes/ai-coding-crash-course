import { backfillBadges } from "../app/services/badgeService";

// ─── Badge backfill ───
// Awards existing students the badges their progress already earned, dated
// when they earned them and left unseen so they show as "New" on the
// dashboard. Also fills enrollments.completedAt for finished courses.
// Idempotent: run it as often as needed with `npm run db:backfill-badges`.

const { userCount, badgesAwarded } = backfillBadges();
console.log(`Backfilled badges: ${badgesAwarded} awarded across ${userCount} users.`);
