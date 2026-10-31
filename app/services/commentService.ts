import { eq, asc } from "drizzle-orm";
import { db } from "~/db";
import { lessonComments, users, CourseStatus, UserRole } from "~/db/schema";

// ─── Comment Service ───
// Handles lesson comments: one level of replies, soft deletes, and the
// permission rules for who can read, post, edit, and delete.
// Uses positional parameters (project convention).

export type CommentViewer = {
  userId: number;
  role: UserRole;
  isCourseInstructor: boolean;
  // Enrolled and not blocked by the PPP guard
  hasStudentAccess: boolean;
};

// The permission checks only need these fields, so they accept both DB rows
// and LessonCommentView objects.
type CommentRef = Pick<typeof lessonComments.$inferSelect, "userId" | "deletedAt">;

// ─── Permissions ───

function isModerator(viewer: CommentViewer) {
  return viewer.role === UserRole.Admin || viewer.isCourseInstructor;
}

export function canViewComments(viewer: CommentViewer | null) {
  if (!viewer) return false;
  return isModerator(viewer) || viewer.hasStudentAccess;
}

export function canPostComment(
  viewer: CommentViewer | null,
  courseStatus: CourseStatus
) {
  if (!viewer || !canViewComments(viewer)) return false;
  if (courseStatus === CourseStatus.Archived) return false;
  if (courseStatus === CourseStatus.Draft) return isModerator(viewer);
  return true;
}

export function canEditComment(
  viewer: CommentViewer | null,
  comment: CommentRef,
  courseStatus: CourseStatus
) {
  if (!viewer || comment.deletedAt) return false;
  return comment.userId === viewer.userId && canPostComment(viewer, courseStatus);
}

export function canDeleteComment(
  viewer: CommentViewer | null,
  comment: CommentRef,
  courseStatus: CourseStatus
) {
  if (!viewer || comment.deletedAt) return false;
  if (!canViewComments(viewer)) return false;
  if (isModerator(viewer)) return true;
  // Archived courses are read-only for authors; moderators can still clean up
  return (
    comment.userId === viewer.userId && courseStatus !== CourseStatus.Archived
  );
}

// ─── Queries ───

export function getCommentById(id: number) {
  return db
    .select()
    .from(lessonComments)
    .where(eq(lessonComments.id, id))
    .get();
}

export type LessonCommentView = {
  id: number;
  userId: number;
  authorName: string;
  authorAvatarUrl: string | null;
  isInstructor: boolean;
  // Null when the comment was deleted but kept as a placeholder for its replies
  content: string | null;
  deletedAt: string | null;
  edited: boolean;
  createdAt: string;
  replies: LessonCommentView[];
};

/**
 * Returns the lesson's comment threads: top-level comments newest first,
 * replies oldest first. Deleted comments are hidden, except a deleted
 * top-level comment with visible replies, which is kept as a placeholder.
 */
export function getCommentThreadsForLesson(
  lessonId: number,
  courseInstructorId: number
): LessonCommentView[] {
  const rows = db
    .select({
      comment: lessonComments,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(lessonComments)
    .innerJoin(users, eq(lessonComments.userId, users.id))
    .where(eq(lessonComments.lessonId, lessonId))
    .orderBy(asc(lessonComments.createdAt), asc(lessonComments.id))
    .all();

  const toView = (row: (typeof rows)[number]): LessonCommentView => {
    const c = row.comment;
    const deleted = c.deletedAt !== null;
    return {
      id: c.id,
      userId: c.userId,
      authorName: row.authorName,
      authorAvatarUrl: row.authorAvatarUrl,
      isInstructor: c.userId === courseInstructorId,
      content: deleted ? null : c.content,
      deletedAt: c.deletedAt,
      edited: !deleted && c.updatedAt !== c.createdAt,
      createdAt: c.createdAt,
      replies: [],
    };
  };

  const repliesByParent = new Map<number, LessonCommentView[]>();
  for (const row of rows) {
    const parentId = row.comment.parentId;
    if (parentId === null || row.comment.deletedAt) continue;
    const list = repliesByParent.get(parentId) ?? [];
    list.push(toView(row));
    repliesByParent.set(parentId, list);
  }

  const threads: LessonCommentView[] = [];
  for (const row of rows) {
    if (row.comment.parentId !== null) continue;
    const view = toView(row);
    view.replies = repliesByParent.get(view.id) ?? [];
    if (view.deletedAt && view.replies.length === 0) continue;
    threads.push(view);
  }

  return threads.reverse();
}

// ─── Mutations ───

/**
 * Creates a comment. Returns null if parentId doesn't point at a live
 * top-level comment on the same lesson.
 */
export function createComment(
  lessonId: number,
  userId: number,
  content: string,
  parentId: number | null = null
) {
  if (parentId !== null) {
    const parent = getCommentById(parentId);
    if (
      !parent ||
      parent.lessonId !== lessonId ||
      parent.parentId !== null ||
      parent.deletedAt
    ) {
      return null;
    }
  }

  return db
    .insert(lessonComments)
    .values({ lessonId, userId, content, parentId })
    .returning()
    .get();
}

export function updateComment(id: number, content: string) {
  return db
    .update(lessonComments)
    .set({ content, updatedAt: new Date().toISOString() })
    .where(eq(lessonComments.id, id))
    .returning()
    .get();
}

export function softDeleteComment(id: number) {
  return db
    .update(lessonComments)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(lessonComments.id, id))
    .returning()
    .get();
}
