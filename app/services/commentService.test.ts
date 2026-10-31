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

// Import after mock so the module picks up our test db
import {
  canViewComments,
  canPostComment,
  canEditComment,
  canDeleteComment,
  createComment,
  getCommentById,
  getCommentThreadsForLesson,
  updateComment,
  softDeleteComment,
  type CommentViewer,
} from "./commentService";

const { Published, Draft, Archived } = schema.CourseStatus;

function createLesson() {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson 1", position: 1 })
    .returning()
    .get();
}

function student(overrides: Partial<CommentViewer> = {}): CommentViewer {
  return {
    userId: base.user.id,
    role: schema.UserRole.Student,
    isCourseInstructor: false,
    hasStudentAccess: true,
    ...overrides,
  };
}

function instructor(): CommentViewer {
  return {
    userId: base.instructor.id,
    role: schema.UserRole.Instructor,
    isCourseInstructor: true,
    hasStudentAccess: false,
  };
}

function admin(): CommentViewer {
  return {
    userId: 999,
    role: schema.UserRole.Admin,
    isCourseInstructor: false,
    hasStudentAccess: false,
  };
}

describe("commentService", () => {
  let lessonId: number;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    lessonId = createLesson().id;
  });

  describe("permissions", () => {
    it("lets students with access, the course instructor, and admins view", () => {
      expect(canViewComments(student())).toBe(true);
      expect(canViewComments(instructor())).toBe(true);
      expect(canViewComments(admin())).toBe(true);
    });

    it("hides comments from anonymous users and students without access", () => {
      expect(canViewComments(null)).toBe(false);
      expect(canViewComments(student({ hasStudentAccess: false }))).toBe(false);
    });

    it("does not let an instructor of another course view", () => {
      const otherInstructor: CommentViewer = {
        ...instructor(),
        isCourseInstructor: false,
      };
      expect(canViewComments(otherInstructor)).toBe(false);
    });

    it("blocks posting on archived courses for everyone", () => {
      expect(canPostComment(student(), Archived)).toBe(false);
      expect(canPostComment(instructor(), Archived)).toBe(false);
      expect(canPostComment(admin(), Archived)).toBe(false);
    });

    it("only lets moderators post on draft courses", () => {
      expect(canPostComment(student(), Draft)).toBe(false);
      expect(canPostComment(instructor(), Draft)).toBe(true);
      expect(canPostComment(admin(), Draft)).toBe(true);
    });

    it("only lets the author edit", () => {
      const comment = createComment(lessonId, base.user.id, "Hi")!;
      expect(canEditComment(student(), comment, Published)).toBe(true);
      expect(canEditComment(instructor(), comment, Published)).toBe(false);
      expect(canEditComment(admin(), comment, Published)).toBe(false);
    });

    it("blocks editing once the author loses access or the course is archived", () => {
      const comment = createComment(lessonId, base.user.id, "Hi")!;
      expect(
        canEditComment(student({ hasStudentAccess: false }), comment, Published)
      ).toBe(false);
      expect(canEditComment(student(), comment, Archived)).toBe(false);
    });

    it("lets the author and moderators delete", () => {
      const comment = createComment(lessonId, base.instructor.id, "Hi")!;
      expect(canDeleteComment(instructor(), comment, Published)).toBe(true);
      expect(canDeleteComment(admin(), comment, Published)).toBe(true);
      expect(canDeleteComment(student(), comment, Published)).toBe(false);
    });

    it("lets moderators but not authors delete on archived courses", () => {
      const comment = createComment(lessonId, base.user.id, "Hi")!;
      expect(canDeleteComment(student(), comment, Archived)).toBe(false);
      expect(canDeleteComment(instructor(), comment, Archived)).toBe(true);
    });

    it("does not allow editing or deleting an already deleted comment", () => {
      const comment = createComment(lessonId, base.user.id, "Hi")!;
      const deleted = softDeleteComment(comment.id)!;
      expect(canEditComment(student(), deleted, Published)).toBe(false);
      expect(canDeleteComment(admin(), deleted, Published)).toBe(false);
    });
  });

  describe("createComment", () => {
    it("creates a top-level comment", () => {
      const comment = createComment(lessonId, base.user.id, "Great lesson");
      expect(comment).toBeDefined();
      expect(comment!.parentId).toBeNull();
      expect(comment!.content).toBe("Great lesson");
    });

    it("creates a reply to a top-level comment", () => {
      const parent = createComment(lessonId, base.user.id, "Question")!;
      const reply = createComment(lessonId, base.instructor.id, "Answer", parent.id);
      expect(reply!.parentId).toBe(parent.id);
    });

    it("rejects replies to replies", () => {
      const parent = createComment(lessonId, base.user.id, "Question")!;
      const reply = createComment(lessonId, base.instructor.id, "Answer", parent.id)!;
      expect(createComment(lessonId, base.user.id, "Nested", reply.id)).toBeNull();
    });

    it("rejects replies to comments on another lesson", () => {
      const otherLesson = createLesson();
      const parent = createComment(otherLesson.id, base.user.id, "Question")!;
      expect(createComment(lessonId, base.user.id, "Reply", parent.id)).toBeNull();
    });

    it("rejects replies to deleted comments", () => {
      const parent = createComment(lessonId, base.user.id, "Question")!;
      softDeleteComment(parent.id);
      expect(createComment(lessonId, base.user.id, "Reply", parent.id)).toBeNull();
    });
  });

  describe("updateComment", () => {
    it("updates content and bumps updatedAt", async () => {
      const comment = createComment(lessonId, base.user.id, "Old")!;
      await new Promise((r) => setTimeout(r, 5));
      const updated = updateComment(comment.id, "New")!;
      expect(updated.content).toBe("New");
      expect(updated.updatedAt).not.toBe(comment.updatedAt);
    });
  });

  describe("softDeleteComment", () => {
    it("sets deletedAt without removing the row", () => {
      const comment = createComment(lessonId, base.user.id, "Bye")!;
      softDeleteComment(comment.id);
      expect(getCommentById(comment.id)!.deletedAt).not.toBeNull();
    });
  });

  describe("getCommentThreadsForLesson", () => {
    it("orders top-level comments newest first and replies oldest first", () => {
      const first = createComment(lessonId, base.user.id, "First")!;
      const second = createComment(lessonId, base.user.id, "Second")!;
      createComment(lessonId, base.instructor.id, "Reply A", first.id);
      createComment(lessonId, base.user.id, "Reply B", first.id);

      const threads = getCommentThreadsForLesson(lessonId, base.instructor.id);

      expect(threads.map((t) => t.id)).toEqual([second.id, first.id]);
      expect(threads[1].replies.map((r) => r.content)).toEqual([
        "Reply A",
        "Reply B",
      ]);
    });

    it("flags comments by the course instructor", () => {
      createComment(lessonId, base.instructor.id, "From instructor");
      createComment(lessonId, base.user.id, "From student");

      const threads = getCommentThreadsForLesson(lessonId, base.instructor.id);

      expect(threads.find((t) => t.content === "From instructor")!.isInstructor).toBe(true);
      expect(threads.find((t) => t.content === "From student")!.isInstructor).toBe(false);
    });

    it("hides deleted comments without replies", () => {
      const comment = createComment(lessonId, base.user.id, "Gone")!;
      softDeleteComment(comment.id);
      expect(getCommentThreadsForLesson(lessonId, base.instructor.id)).toEqual([]);
    });

    it("keeps a deleted comment with replies as a placeholder", () => {
      const parent = createComment(lessonId, base.user.id, "Secret")!;
      createComment(lessonId, base.instructor.id, "Reply", parent.id);
      softDeleteComment(parent.id);

      const [thread] = getCommentThreadsForLesson(lessonId, base.instructor.id);

      expect(thread.deletedAt).not.toBeNull();
      expect(thread.content).toBeNull();
      expect(thread.replies).toHaveLength(1);
    });

    it("hides deleted replies and drops the placeholder once all replies are gone", () => {
      const parent = createComment(lessonId, base.user.id, "Question")!;
      const reply = createComment(lessonId, base.instructor.id, "Reply", parent.id)!;
      softDeleteComment(parent.id);
      softDeleteComment(reply.id);

      expect(getCommentThreadsForLesson(lessonId, base.instructor.id)).toEqual([]);
    });

    it("marks edited comments", async () => {
      const comment = createComment(lessonId, base.user.id, "Old")!;
      await new Promise((r) => setTimeout(r, 5));
      updateComment(comment.id, "New");

      const [thread] = getCommentThreadsForLesson(lessonId, base.instructor.id);

      expect(thread.edited).toBe(true);
      expect(thread.content).toBe("New");
    });

    it("only returns comments for the given lesson", () => {
      const otherLesson = createLesson();
      createComment(otherLesson.id, base.user.id, "Elsewhere");
      expect(getCommentThreadsForLesson(lessonId, base.instructor.id)).toEqual([]);
    });
  });
});
