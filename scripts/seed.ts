import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../app/db/schema";
import {
  UserRole,
  CourseStatus,
  LessonProgressStatus,
  QuestionType,
  TeamMemberRole,
  BadgeType,
} from "../app/db/schema";
import { calculatePppPrice } from "../app/lib/ppp";
import { evaluateBadgesForUser } from "../app/services/badgeService";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../drizzle");

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite, { schema });

// ─── Helpers ───

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// A moment on a UTC day relative to today. Hour 0 of today is never in the
// future, so it is safe for "done today" data.
function utcDayAt(daysBack: number, hour: number): string {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString();
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ─── Seed Data ───

async function seed() {
  console.log("Seeding database...");

  // Drop and recreate tables for a clean seed
  sqlite.exec(`
    DROP TABLE IF EXISTS user_badges;
    DROP TABLE IF EXISTS lesson_comments;
    DROP TABLE IF EXISTS video_watch_events;
    DROP TABLE IF EXISTS quiz_answers;
    DROP TABLE IF EXISTS quiz_attempts;
    DROP TABLE IF EXISTS quiz_options;
    DROP TABLE IF EXISTS quiz_questions;
    DROP TABLE IF EXISTS quizzes;
    DROP TABLE IF EXISTS lesson_progress;
    DROP TABLE IF EXISTS coupons;
    DROP TABLE IF EXISTS team_members;
    DROP TABLE IF EXISTS teams;
    DROP TABLE IF EXISTS purchases;
    DROP TABLE IF EXISTS enrollments;
    DROP TABLE IF EXISTS lessons;
    DROP TABLE IF EXISTS modules;
    DROP TABLE IF EXISTS courses;
    DROP TABLE IF EXISTS categories;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS __drizzle_migrations;
  `);

  // Create tables using the same Drizzle migrations as the live database
  migrate(db, { migrationsFolder });

  console.log("Tables created.");

  // ─── Users ───
  // 1 admin, 2 instructors, 5 students

  const [admin] = db
    .insert(schema.users)
    .values({
      name: "Alex Rivera",
      email: "alex.rivera@ralph.dev",
      role: UserRole.Admin,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=alex",
      createdAt: daysAgo(120),
    })
    .returning()
    .all();

  const [instructor1] = db
    .insert(schema.users)
    .values({
      name: "Sarah Chen",
      email: "sarah.chen@ralph.dev",
      role: UserRole.Instructor,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=sarah",
      bio: "Senior TypeScript engineer with 10 years of experience building large-scale web applications. Previously at Stripe and Vercel. Passionate about type safety and developer tooling.",
      createdAt: daysAgo(100),
    })
    .returning()
    .all();

  const [instructor2] = db
    .insert(schema.users)
    .values({
      name: "Marcus Johnson",
      email: "marcus.johnson@ralph.dev",
      role: UserRole.Instructor,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=marcus",
      bio: "Full-stack developer and API architect specializing in Node.js and cloud infrastructure. Has built and scaled APIs serving millions of requests daily. Conference speaker and open-source contributor.",
      createdAt: daysAgo(95),
    })
    .returning()
    .all();

  const students = db
    .insert(schema.users)
    .values([
      {
        name: "Emma Wilson",
        email: "emma.wilson@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=emma",
        createdAt: daysAgo(60),
      },
      {
        name: "James Park",
        email: "james.park@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=james",
        createdAt: daysAgo(55),
      },
      {
        name: "Olivia Martinez",
        email: "olivia.martinez@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=olivia",
        createdAt: daysAgo(45),
      },
      {
        name: "Liam Thompson",
        email: "liam.thompson@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=liam",
        createdAt: daysAgo(30),
      },
      {
        name: "Sophia Davis",
        email: "sophia.davis@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=sophia",
        createdAt: daysAgo(20),
      },
    ])
    .returning()
    .all();

  const [bossy] = db
    .insert(schema.users)
    .values({
      name: "Bossy McBossface",
      email: "bossy.mcbossface@student.dev",
      role: UserRole.Student,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=bossy",
      createdAt: daysAgo(40),
    })
    .returning()
    .all();

  console.log(
    `Created ${1 + 2 + students.length + 1} users (1 admin, 2 instructors, ${students.length + 1} students).`
  );

  // ─── Categories ───

  const categoriesData = db
    .insert(schema.categories)
    .values([
      { name: "Programming", slug: "programming" },
      { name: "Design", slug: "design" },
      { name: "Data Science", slug: "data-science" },
      { name: "DevOps", slug: "devops" },
      { name: "Marketing", slug: "marketing" },
    ])
    .returning()
    .all();

  const catBySlug = Object.fromEntries(categoriesData.map((c) => [c.slug, c]));

  console.log(`Created ${categoriesData.length} categories.`);

  // ─── Course 1: Introduction to TypeScript (Sarah Chen) ───

  const [course1] = db
    .insert(schema.courses)
    .values({
      title: "Introduction to TypeScript",
      slug: "introduction-to-typescript",
      description:
        "Master TypeScript from the ground up. Learn type annotations, interfaces, generics, and advanced patterns that will make your JavaScript code safer and more maintainable. Includes hands-on projects and real-world examples.",
      salesCopy: `## Why TypeScript?

If you've been writing JavaScript and wondering why your code breaks in production with cryptic "undefined is not a function" errors, TypeScript is the answer you've been looking for.

TypeScript adds a powerful type system on top of JavaScript that catches bugs before they ever reach your users. It's not just about finding errors — it's about writing code with confidence, knowing that your editor understands your code as well as you do.

## What You'll Learn

This course takes you from zero TypeScript knowledge to confidently using advanced patterns in real projects. We start with the basics — type annotations, interfaces, and simple generics — and build up to discriminated unions, mapped types, conditional types, and template literal types.

Every concept is taught through practical examples. You won't just learn what a generic is — you'll learn when and why to use one, and how to constrain them for maximum type safety.

### Course Highlights

- **19 lessons** across 5 modules, from setup to advanced patterns
- **Hands-on quizzes** to test your understanding as you go
- **Real-world React examples** showing TypeScript in production code
- **Error handling patterns** using Result types and discriminated unions

## Who Is This Course For?

This course is perfect for JavaScript developers who want to level up their code quality. Whether you're working on a personal project or a large team codebase, TypeScript will make your development experience faster, safer, and more enjoyable.

No prior TypeScript experience required — just a solid understanding of JavaScript fundamentals.

## What Makes This Course Different

Unlike courses that just show you syntax, this course focuses on *thinking in types*. You'll learn to design your types first and let them guide your implementation, catching entire categories of bugs at compile time instead of runtime.

By the end of this course, you'll understand why TypeScript has become the default choice for serious JavaScript development.`,
      instructorId: instructor1.id,
      categoryId: catBySlug["programming"].id,
      status: CourseStatus.Published,
      coverImageUrl: "/images/course-typescript.svg",
      price: 4999,
      createdAt: daysAgo(90),
      updatedAt: daysAgo(10),
    })
    .returning()
    .all();

  // Course 1 modules and lessons
  const c1Modules = [
    {
      title: "Getting Started with TypeScript",
      lessons: [
        {
          title: "What is TypeScript?",
          duration: 8,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-intro-what-is-ts",
          content: `## What is TypeScript?

TypeScript is a typed superset of JavaScript that compiles to plain JavaScript. It adds optional static typing and class-based object-oriented programming to the language.

### Why TypeScript?

- Catch errors at compile time instead of runtime
- Better IDE support with autocompletion
- Easier to refactor large codebases
- Self-documenting code through types`,
        },
        {
          title: "Installing and Configuring TypeScript",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Setting Up TypeScript

Let's get TypeScript installed and configured in your development environment.

### Installation

\`\`\`bash
npm install -g typescript
tsc --version
\`\`\`

### tsconfig.json

The \`tsconfig.json\` file configures the TypeScript compiler options for your project.`,
        },
        {
          title: "Your First TypeScript Program",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-intro-first-program",
          content: `## Hello, TypeScript!

Let's write our first TypeScript program and see the compilation process in action.

\`\`\`typescript
function greet(name: string): string {
  return \\\`Hello, \\\${name}!\\\`;
}

console.log(greet('World'));
\`\`\``,
        },
      ],
    },
    {
      title: "Type System Fundamentals",
      lessons: [
        {
          title: "Primitive Types",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Primitive Types

TypeScript supports the same primitive types as JavaScript, plus a few extras.

- \`string\` — text values
- \`number\` — numeric values (integer and float)
- \`boolean\` — true/false
- \`null\` and \`undefined\`
- \`symbol\` and \`bigint\``,
        },
        {
          title: "Arrays and Tuples",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Arrays and Tuples

Learn how to type arrays and fixed-length tuples in TypeScript.

\`\`\`typescript
const numbers: number[] = [1, 2, 3];
const pair: [string, number] = ['age', 25];
\`\`\``,
        },
        {
          title: "Type Aliases and Interfaces",
          duration: 18,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Type Aliases vs Interfaces

Both type aliases and interfaces let you define custom types, but they have subtle differences.

### Type Alias

\`\`\`typescript
type User = {
  name: string;
  age: number;
};
\`\`\`

### Interface

\`\`\`typescript
interface User {
  name: string;
  age: number;
}
\`\`\``,
        },
        {
          title: "Union and Intersection Types",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Union and Intersection Types

Combine types in powerful ways using unions (\`|\`) and intersections (\`&\`).

\`\`\`typescript
type StringOrNumber = string | number;
type Named = { name: string };
type Aged = { age: number };
type Person = Named & Aged;
\`\`\``,
        },
      ],
    },
    {
      title: "Functions and Generics",
      lessons: [
        {
          title: "Function Types",
          duration: 11,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Typing Functions

TypeScript lets you type function parameters, return values, and even the function itself.

\`\`\`typescript
function add(a: number, b: number): number {
  return a + b;
}

const multiply: (a: number, b: number) => number = (a, b) => a * b;
\`\`\``,
        },
        {
          title: "Generics Basics",
          duration: 20,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-generics-basics",
          content: `## Introduction to Generics

Generics let you write reusable code that works with multiple types while maintaining type safety.

\`\`\`typescript
function identity<T>(value: T): T {
  return value;
}

const str = identity('hello'); // string
const num = identity(42); // number
\`\`\``,
        },
        {
          title: "Generic Constraints",
          duration: 16,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Constraining Generics

Use \`extends\` to limit what types a generic can accept.

\`\`\`typescript
function getLength<T extends { length: number }>(item: T): number {
  return item.length;
}

getLength('hello'); // OK
getLength([1, 2, 3]); // OK
// getLength(42); // Error!
\`\`\``,
        },
        {
          title: "Utility Types",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Built-in Utility Types

TypeScript provides several utility types for common type transformations.

- \`Partial<T>\` — makes all properties optional
- \`Required<T>\` — makes all properties required
- \`Pick<T, K>\` — selects specific properties
- \`Omit<T, K>\` — excludes specific properties
- \`Record<K, V>\` — creates an object type with keys K and values V`,
        },
      ],
    },
    {
      title: "Advanced Patterns",
      lessons: [
        {
          title: "Discriminated Unions",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Discriminated Unions

A pattern that combines union types with literal types to create type-safe tagged unions.

\`\`\`typescript
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rectangle'; width: number; height: number };

function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle': return Math.PI * shape.radius ** 2;
    case 'rectangle': return shape.width * shape.height;
  }
}
\`\`\``,
        },
        {
          title: "Type Guards and Narrowing",
          duration: 13,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Type Guards

Type guards are expressions that narrow a type within a conditional block.

\`\`\`typescript
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function process(value: string | number) {
  if (isString(value)) {
    console.log(value.toUpperCase()); // string
  } else {
    console.log(value.toFixed(2)); // number
  }
}
\`\`\``,
        },
        {
          title: "Mapped Types",
          duration: 17,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Mapped Types

Create new types by transforming each property of an existing type.

\`\`\`typescript
type Readonly<T> = {
  readonly [K in keyof T]: T[K];
};

type Optional<T> = {
  [K in keyof T]?: T[K];
};
\`\`\``,
        },
        {
          title: "Conditional Types",
          duration: 19,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Conditional Types

Types that depend on a condition, similar to ternary expressions but at the type level.

\`\`\`typescript
type IsString<T> = T extends string ? true : false;

type A = IsString<'hello'>; // true
type B = IsString<42>; // false
\`\`\``,
        },
        {
          title: "Template Literal Types",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Template Literal Types

Construct string types using template literal syntax.

\`\`\`typescript
type Color = 'red' | 'blue' | 'green';
type CSSProperty = \\\`color-\\\${Color}\\\`;
// 'color-red' | 'color-blue' | 'color-green'
\`\`\``,
        },
      ],
    },
    {
      title: "Real-World TypeScript",
      lessons: [
        {
          title: "TypeScript with React",
          duration: 22,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-react-examples",
          content: `## TypeScript + React

Learn how to use TypeScript effectively in React applications.

\`\`\`typescript
interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  return <button onClick={onClick} className={variant}>{label}</button>;
}
\`\`\``,
        },
        {
          title: "Error Handling Patterns",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Error Handling in TypeScript

Strategies for handling errors in a type-safe way.

\`\`\`typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function divide(a: number, b: number): Result<number> {
  if (b === 0) return { ok: false, error: new Error('Division by zero') };
  return { ok: true, value: a / b };
}
\`\`\``,
        },
        {
          title: "Course Wrap-Up and Next Steps",
          duration: 8,
          content: `## Congratulations!

You've completed the Introduction to TypeScript course. Here's what we covered:

- TypeScript fundamentals and type system
- Functions, generics, and utility types
- Advanced patterns like discriminated unions and mapped types
- Real-world usage with React

### Next Steps

Practice by converting an existing JavaScript project to TypeScript. Start with strict mode enabled and work through the errors one by one.`,
        },
      ],
    },
  ];

  const course1LessonIds: number[] = [];

  for (let mi = 0; mi < c1Modules.length; mi++) {
    const modData = c1Modules[mi];
    const [mod] = db
      .insert(schema.modules)
      .values({
        courseId: course1.id,
        title: modData.title,
        position: mi + 1,
        createdAt: daysAgo(90 - mi),
      })
      .returning()
      .all();

    for (let li = 0; li < modData.lessons.length; li++) {
      const lessonData = modData.lessons[li];
      const [lesson] = db
        .insert(schema.lessons)
        .values({
          moduleId: mod.id,
          title: lessonData.title,
          content: lessonData.content,
          videoUrl: lessonData.videoUrl ?? null,
          githubRepoUrl:
            ("githubRepoUrl" in lessonData ? lessonData.githubRepoUrl : null) ??
            null,
          position: li + 1,
          durationMinutes: lessonData.duration,
          createdAt: daysAgo(90 - mi),
        })
        .returning()
        .all();
      course1LessonIds.push(lesson.id);
    }
  }

  console.log(
    `Created course "${course1.title}" with ${c1Modules.length} modules and ${course1LessonIds.length} lessons.`
  );

  // ─── Course 2: Building REST APIs with Node.js (Marcus Johnson) ───

  const [course2] = db
    .insert(schema.courses)
    .values({
      title: "Building REST APIs with Node.js",
      slug: "building-rest-apis-with-nodejs",
      description:
        "Learn to build production-ready REST APIs using Node.js and Express. Covers routing, middleware, authentication, database integration, error handling, testing, and deployment best practices.",
      salesCopy: `## Build APIs That Actually Work in Production

Most API tutorials teach you how to return JSON from an endpoint. This course teaches you how to build APIs that handle real traffic, real users, and real problems — the kind you'll face on the job.

From your first Express route to deploying a production-ready API, you'll learn every layer of the stack: routing, middleware, validation, authentication, database integration, testing, and deployment.

## What You'll Build

Throughout this course, you'll build a complete REST API from scratch. Not a toy project — a properly structured API with authentication, input validation, error handling, pagination, and tests.

### Topics Covered

- **Express fundamentals** — routing, middleware chains, request/response lifecycle
- **Input validation with Zod** — never trust user input, validate everything
- **Database integration** — Drizzle ORM with SQLite, CRUD operations, transactions
- **JWT authentication** — secure your endpoints with industry-standard tokens
- **Security hardening** — rate limiting, CORS, security headers with Helmet
- **Testing** — unit tests with Vitest, integration tests with Supertest
- **Deployment** — environment config, process management, CI/CD basics

## Who Should Take This Course?

This course is designed for developers who know JavaScript and want to build backend services. If you've built frontends but never created your own API, this is the perfect next step.

You should be comfortable with JavaScript basics — functions, async/await, and working with objects. No backend experience required.

## Why Node.js for APIs?

Node.js lets you use the same language on both frontend and backend. Its non-blocking I/O model handles concurrent requests efficiently, and the npm ecosystem gives you battle-tested libraries for every common backend task.

Express is the most widely-used Node.js web framework for a reason — it's minimal, flexible, and has a massive community. The patterns you learn here will transfer to any Node.js framework.

## 20 Lessons, 5 Modules, Zero Fluff

Every lesson is focused and practical. No 45-minute lectures where 40 minutes are filler. Each lesson teaches one concept, shows you how to implement it, and moves on.`,
      instructorId: instructor2.id,
      categoryId: catBySlug["programming"].id,
      status: CourseStatus.Published,
      coverImageUrl: "/images/course-nodejs.svg",
      price: 5999,
      createdAt: daysAgo(75),
      updatedAt: daysAgo(5),
    })
    .returning()
    .all();

  const c2Modules = [
    {
      title: "API Fundamentals",
      lessons: [
        {
          title: "What is a REST API?",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## REST API Fundamentals

REST (Representational State Transfer) is an architectural style for designing networked applications. RESTful APIs use HTTP methods to perform CRUD operations on resources.

### Key Principles

- Stateless communication
- Resource-based URLs
- Standard HTTP methods (GET, POST, PUT, DELETE)
- JSON as the data format`,
        },
        {
          title: "Setting Up Express",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          githubRepoUrl:
            "https://github.com/total-typescript/rest-api-express-setup",
          content: `## Express.js Setup

Express is the most popular Node.js web framework for building APIs.

\`\`\`javascript
import express from 'express';

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(3000, () => console.log('Server running on port 3000'));
\`\`\``,
        },
        {
          title: "HTTP Methods and Status Codes",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## HTTP Methods

- **GET** — Retrieve resources (200 OK)
- **POST** — Create resources (201 Created)
- **PUT** — Update resources (200 OK)
- **DELETE** — Remove resources (204 No Content)

### Common Status Codes

- 200 OK, 201 Created, 204 No Content
- 400 Bad Request, 401 Unauthorized, 404 Not Found
- 500 Internal Server Error`,
        },
        {
          title: "Request and Response Objects",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Working with Request & Response

Express provides rich request and response objects for handling HTTP communication.

\`\`\`javascript
app.post('/api/users', (req, res) => {
  const { name, email } = req.body;
  // ... create user
  res.status(201).json({ id: 1, name, email });
});
\`\`\``,
        },
      ],
    },
    {
      title: "Routing and Middleware",
      lessons: [
        {
          title: "Express Router",
          duration: 13,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Organizing Routes

Use Express Router to organize your API endpoints into logical groups.

\`\`\`javascript
import { Router } from 'express';

const userRouter = Router();
userRouter.get('/', getUsers);
userRouter.get('/:id', getUserById);
userRouter.post('/', createUser);

app.use('/api/users', userRouter);
\`\`\``,
        },
        {
          title: "Custom Middleware",
          duration: 16,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Middleware in Express

Middleware functions have access to the request, response, and next function in the request-response cycle.

\`\`\`javascript
function logger(req, res, next) {
  console.log(\\\`\\\${req.method} \\\${req.url}\\\`);
  next();
}

function authenticate(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
\`\`\``,
        },
        {
          title: "Error Handling Middleware",
          duration: 11,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Centralized Error Handling

Express supports error-handling middleware with four parameters.

\`\`\`javascript
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});
\`\`\``,
        },
        {
          title: "Validation with Zod",
          duration: 18,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Request Validation

Use Zod to validate request bodies, query parameters, and URL parameters.

\`\`\`javascript
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().positive().optional()
});

app.post('/api/users', (req, res) => {
  const result = CreateUserSchema.safeParse(req.body);
  if (!result.success) return res.status(400).json(result.error);
  // ... create user with result.data
});
\`\`\``,
        },
      ],
    },
    {
      title: "Database Integration",
      lessons: [
        {
          title: "Connecting to a Database",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Database Setup

Learn how to connect your API to a database using an ORM.

\`\`\`javascript
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

const sqlite = new Database('app.db');
const db = drizzle(sqlite);
\`\`\``,
        },
        {
          title: "CRUD Operations",
          duration: 20,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          githubRepoUrl:
            "https://github.com/total-typescript/rest-api-crud-operations",
          content: `## Building CRUD Endpoints

Implement Create, Read, Update, Delete operations for your API resources.

\`\`\`javascript
// Create
app.post('/api/posts', async (req, res) => {
  const post = await db.insert(posts).values(req.body).returning();
  res.status(201).json(post);
});

// Read
app.get('/api/posts/:id', async (req, res) => {
  const post = await db.select().from(posts).where(eq(posts.id, req.params.id));
  if (!post) return res.status(404).json({ error: 'Not found' });
  res.json(post);
});
\`\`\``,
        },
        {
          title: "Pagination and Filtering",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Pagination

Implement cursor-based and offset-based pagination for list endpoints.

\`\`\`javascript
app.get('/api/posts', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  const results = await db.select().from(posts)
    .limit(limit).offset(offset);
  res.json({ data: results, page, limit });
});
\`\`\``,
        },
        {
          title: "Transactions",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Database Transactions

Use transactions to ensure data consistency when multiple operations must succeed or fail together.

\`\`\`javascript
await db.transaction(async (tx) => {
  const [order] = await tx.insert(orders).values({ userId, total }).returning();
  for (const item of items) {
    await tx.insert(orderItems).values({ orderId: order.id, ...item });
  }
});
\`\`\``,
        },
      ],
    },
    {
      title: "Authentication and Security",
      lessons: [
        {
          title: "JWT Authentication",
          duration: 22,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## JSON Web Tokens

Implement JWT-based authentication for your API.

\`\`\`javascript
import jwt from 'jsonwebtoken';

app.post('/api/login', async (req, res) => {
  const user = await findUser(req.body.email);
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });
  res.json({ token });
});
\`\`\``,
        },
        {
          title: "Rate Limiting",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Rate Limiting

Protect your API from abuse by limiting the number of requests per client.

\`\`\`javascript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per window
});

app.use('/api/', limiter);
\`\`\``,
        },
        {
          title: "CORS and Security Headers",
          duration: 11,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## CORS Configuration

Configure Cross-Origin Resource Sharing for your API.

\`\`\`javascript
import cors from 'cors';
import helmet from 'helmet';

app.use(cors({ origin: 'https://yourapp.com' }));
app.use(helmet());
\`\`\``,
        },
      ],
    },
    {
      title: "Testing and Deployment",
      lessons: [
        {
          title: "Unit Testing API Routes",
          duration: 18,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Testing with Vitest and Supertest

Write tests for your API endpoints using Vitest and Supertest.

\`\`\`javascript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';

describe('GET /api/users', () => {
  it('returns a list of users', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  });
});
\`\`\``,
        },
        {
          title: "Integration Testing",
          duration: 16,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Integration Tests

Test complete request flows including database interactions.

\`\`\`javascript
describe('User CRUD', () => {
  it('creates and retrieves a user', async () => {
    const createRes = await request(app)
      .post('/api/users')
      .send({ name: 'Test', email: 'test@test.com' });
    expect(createRes.status).toBe(201);

    const getRes = await request(app)
      .get(\\\`/api/users/\\\${createRes.body.id}\\\`);
    expect(getRes.body.name).toBe('Test');
  });
});
\`\`\``,
        },
        {
          title: "Environment Variables and Config",
          duration: 9,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Configuration Management

Manage environment-specific settings with environment variables.

\`\`\`javascript
const config = {
  port: process.env.PORT || 3000,
  dbUrl: process.env.DATABASE_URL || 'sqlite:app.db',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret'
};
\`\`\``,
        },
        {
          title: "Deploying Your API",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Deployment

Deploy your Node.js API to production. We'll cover various hosting options and best practices.

### Deployment Checklist

- Set NODE_ENV=production
- Use a process manager (PM2)
- Set up logging and monitoring
- Configure HTTPS
- Set up CI/CD pipeline`,
        },
        {
          title: "Course Wrap-Up",
          duration: 7,
          content: `## Congratulations!

You've completed the Building REST APIs course. You now have the skills to build, test, and deploy production-ready APIs with Node.js.

### Key Takeaways

- RESTful design principles
- Express routing and middleware
- Database integration and transactions
- Authentication and security
- Testing and deployment`,
        },
      ],
    },
  ];

  const course2LessonIds: number[] = [];

  for (let mi = 0; mi < c2Modules.length; mi++) {
    const modData = c2Modules[mi];
    const [mod] = db
      .insert(schema.modules)
      .values({
        courseId: course2.id,
        title: modData.title,
        position: mi + 1,
        createdAt: daysAgo(75 - mi),
      })
      .returning()
      .all();

    for (let li = 0; li < modData.lessons.length; li++) {
      const lessonData = modData.lessons[li];
      const [lesson] = db
        .insert(schema.lessons)
        .values({
          moduleId: mod.id,
          title: lessonData.title,
          content: lessonData.content,
          videoUrl: lessonData.videoUrl ?? null,
          githubRepoUrl:
            ("githubRepoUrl" in lessonData ? lessonData.githubRepoUrl : null) ??
            null,
          position: li + 1,
          durationMinutes: lessonData.duration,
          createdAt: daysAgo(75 - mi),
        })
        .returning()
        .all();
      course2LessonIds.push(lesson.id);
    }
  }

  console.log(
    `Created course "${course2.title}" with ${c2Modules.length} modules and ${course2LessonIds.length} lessons.`
  );

  // ─── Quizzes ───
  // Add quizzes to some lessons in both courses

  // Quiz 1: TypeScript Basics Quiz (attached to "Your First TypeScript Program", lesson 3 of course 1)
  const [quiz1] = db
    .insert(schema.quizzes)
    .values({
      lessonId: course1LessonIds[2], // "Your First TypeScript Program"
      title: "TypeScript Basics Quiz",
      passingScore: 0.7,
    })
    .returning()
    .all();

  const quiz1Questions = [
    {
      text: "What does TypeScript compile to?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "JavaScript", correct: true },
        { text: "WebAssembly", correct: false },
        { text: "Java bytecode", correct: false },
        { text: "Machine code", correct: false },
      ],
    },
    {
      text: "TypeScript is a superset of JavaScript.",
      type: QuestionType.TrueFalse,
      options: [
        { text: "True", correct: true },
        { text: "False", correct: false },
      ],
    },
    {
      text: "Which file configures the TypeScript compiler?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "tsconfig.json", correct: true },
        { text: "package.json", correct: false },
        { text: "typescript.config.js", correct: false },
        { text: ".tsrc", correct: false },
      ],
    },
  ];

  const quiz1OptionIds: {
    questionId: number;
    optionId: number;
    correct: boolean;
  }[] = [];

  for (let qi = 0; qi < quiz1Questions.length; qi++) {
    const q = quiz1Questions[qi];
    const [question] = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz1.id,
        questionText: q.text,
        questionType: q.type,
        position: qi + 1,
      })
      .returning()
      .all();

    for (const opt of q.options) {
      const [option] = db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: opt.text,
          isCorrect: opt.correct,
        })
        .returning()
        .all();
      quiz1OptionIds.push({
        questionId: question.id,
        optionId: option.id,
        correct: opt.correct,
      });
    }
  }

  // Quiz 2: Generics Quiz (attached to "Generics Basics", lesson index 5 in course 1)
  const [quiz2] = db
    .insert(schema.quizzes)
    .values({
      lessonId: course1LessonIds[7], // "Generics Basics" (module 3, lesson 2)
      title: "Generics Knowledge Check",
      passingScore: 0.6,
    })
    .returning()
    .all();

  const quiz2Questions = [
    {
      text: "What is the primary benefit of generics?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "Code reusability with type safety", correct: true },
        { text: "Faster execution speed", correct: false },
        { text: "Smaller bundle size", correct: false },
        { text: "Better error messages", correct: false },
      ],
    },
    {
      text: "Generic type parameters can be constrained using the 'extends' keyword.",
      type: QuestionType.TrueFalse,
      options: [
        { text: "True", correct: true },
        { text: "False", correct: false },
      ],
    },
  ];

  const quiz2OptionIds: {
    questionId: number;
    optionId: number;
    correct: boolean;
  }[] = [];

  for (let qi = 0; qi < quiz2Questions.length; qi++) {
    const q = quiz2Questions[qi];
    const [question] = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz2.id,
        questionText: q.text,
        questionType: q.type,
        position: qi + 1,
      })
      .returning()
      .all();

    for (const opt of q.options) {
      const [option] = db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: opt.text,
          isCorrect: opt.correct,
        })
        .returning()
        .all();
      quiz2OptionIds.push({
        questionId: question.id,
        optionId: option.id,
        correct: opt.correct,
      });
    }
  }

  // Quiz 3: REST API Basics (attached to "HTTP Methods and Status Codes", lesson index 2 in course 2)
  const [quiz3] = db
    .insert(schema.quizzes)
    .values({
      lessonId: course2LessonIds[2], // "HTTP Methods and Status Codes"
      title: "HTTP Methods Quiz",
      passingScore: 0.7,
    })
    .returning()
    .all();

  const quiz3Questions = [
    {
      text: "Which HTTP method is used to create a new resource?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "POST", correct: true },
        { text: "GET", correct: false },
        { text: "PUT", correct: false },
        { text: "PATCH", correct: false },
      ],
    },
    {
      text: "A 404 status code means the server encountered an internal error.",
      type: QuestionType.TrueFalse,
      options: [
        { text: "True", correct: false },
        { text: "False", correct: true },
      ],
    },
    {
      text: "Which status code indicates successful resource creation?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "201 Created", correct: true },
        { text: "200 OK", correct: false },
        { text: "204 No Content", correct: false },
        { text: "202 Accepted", correct: false },
      ],
    },
  ];

  const quiz3OptionIds: {
    questionId: number;
    optionId: number;
    correct: boolean;
  }[] = [];

  for (let qi = 0; qi < quiz3Questions.length; qi++) {
    const q = quiz3Questions[qi];
    const [question] = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz3.id,
        questionText: q.text,
        questionType: q.type,
        position: qi + 1,
      })
      .returning()
      .all();

    for (const opt of q.options) {
      const [option] = db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: opt.text,
          isCorrect: opt.correct,
        })
        .returning()
        .all();
      quiz3OptionIds.push({
        questionId: question.id,
        optionId: option.id,
        correct: opt.correct,
      });
    }
  }

  console.log("Created 3 quizzes with questions and options.");

  // ─── Lesson check quizzes ───
  // Streaks only count lessons with a quiz, so every lesson of course 1 and the
  // first part of course 2 get a one-question check. That gives the badge demo
  // (Emma's 15-day streak needs 30 quiz lessons) enough material.
  type QuizOptions = { questionId: number; optionId: number; correct: boolean }[];
  const quizByLesson = new Map<number, { id: number; optionIds: QuizOptions }>([
    [course1LessonIds[2], { id: quiz1.id, optionIds: quiz1OptionIds }],
    [course1LessonIds[7], { id: quiz2.id, optionIds: quiz2OptionIds }],
    [course2LessonIds[2], { id: quiz3.id, optionIds: quiz3OptionIds }],
  ]);

  const checkQuizLessonIds = [...course1LessonIds, ...course2LessonIds.slice(0, 11)];
  for (const lessonId of checkQuizLessonIds) {
    if (quizByLesson.has(lessonId)) continue;

    const [quiz] = db
      .insert(schema.quizzes)
      .values({ lessonId, title: "Lesson Check", passingScore: 0.7 })
      .returning()
      .all();
    const [question] = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz.id,
        questionText: "I can explain the main idea of this lesson in my own words.",
        questionType: QuestionType.TrueFalse,
        position: 1,
      })
      .returning()
      .all();
    const optionIds: QuizOptions = [];
    for (const opt of [
      { text: "True", correct: true },
      { text: "False", correct: false },
    ]) {
      const [option] = db
        .insert(schema.quizOptions)
        .values({ questionId: question.id, optionText: opt.text, isCorrect: opt.correct })
        .returning()
        .all();
      optionIds.push({ questionId: question.id, optionId: option.id, correct: opt.correct });
    }
    quizByLesson.set(lessonId, { id: quiz.id, optionIds });
  }

  console.log(`Created lesson check quizzes (${quizByLesson.size} lessons with a quiz).`);

  // ─── Enrollments ───
  // Varied enrollment patterns:
  // - Emma: enrolled in both courses (completed course 1, mid-way in course 2)
  // - James: enrolled in course 1 only (most of it done, on an active streak)
  // - Olivia: enrolled in both courses (one lesson left in course 1, mid-way in course 2)
  // - Liam: enrolled in course 2 only (just started, abandoned)
  // - Sophia: enrolled in course 1 only (recently enrolled, barely started)

  db.insert(schema.enrollments)
    .values([
      { userId: students[0].id, courseId: course1.id, enrolledAt: daysAgo(50) },
      { userId: students[0].id, courseId: course2.id, enrolledAt: daysAgo(40) },
      { userId: students[1].id, courseId: course1.id, enrolledAt: daysAgo(45) },
      { userId: students[2].id, courseId: course1.id, enrolledAt: daysAgo(35) },
      { userId: students[2].id, courseId: course2.id, enrolledAt: daysAgo(30) },
      { userId: students[3].id, courseId: course2.id, enrolledAt: daysAgo(25) },
      { userId: students[4].id, courseId: course1.id, enrolledAt: daysAgo(15) },
    ])
    .run();

  console.log("Created 7 enrollments.");

  // ─── Lesson Progress ───

  // Helper to mark lessons as complete
  function markComplete(
    userId: number,
    lessonId: number,
    daysAgoCompleted: number
  ) {
    db.insert(schema.lessonProgress)
      .values({
        userId,
        lessonId,
        status: LessonProgressStatus.Completed,
        completedAt: daysAgo(daysAgoCompleted),
      })
      .run();
  }

  function markInProgress(userId: number, lessonId: number) {
    db.insert(schema.lessonProgress)
      .values({
        userId,
        lessonId,
        status: LessonProgressStatus.InProgress,
      })
      .run();
  }

  // Emma's and James's progress is laid out by the badge demo after the quiz
  // attempts below, because it pairs each completion with a passed quiz.

  // Olivia (students[2]) — one lesson left in course 1. Marking the last
  // lesson complete demos the live "Badge unlocked" toast.
  const oliviaLastLesson = course1LessonIds.length - 1;
  for (let i = 0; i < oliviaLastLesson; i++) {
    markComplete(students[2].id, course1LessonIds[i], 30 - i);
  }
  markInProgress(students[2].id, course1LessonIds[oliviaLastLesson]);

  // Olivia — mid-way through course 2 (8 lessons done)
  for (let i = 0; i < 8; i++) {
    markComplete(students[2].id, course2LessonIds[i], 28 - i);
  }

  // Liam (students[3]) — just started course 2, abandoned (2 lessons done)
  for (let i = 0; i < 2; i++) {
    markComplete(students[3].id, course2LessonIds[i], 22 - i);
  }

  // Sophia (students[4]) — barely started course 1 (1 lesson done)
  markComplete(students[4].id, course1LessonIds[0], 12);
  markInProgress(students[4].id, course1LessonIds[1]);

  console.log("Created lesson progress records.");

  // ─── Quiz Attempts ───

  // Helper to record a quiz attempt with answers
  function recordQuizAttempt(
    userId: number,
    quizId: number,
    optionIds: { questionId: number; optionId: number; correct: boolean }[],
    selectedCorrectIndices: number[], // which questions (0-based) the student got right
    attemptedAt: number | string // days ago, or an exact ISO timestamp
  ) {
    const totalQuestions = new Set(optionIds.map((o) => o.questionId)).size;
    const correctCount = selectedCorrectIndices.length;
    const score = correctCount / totalQuestions;

    // Determine passing based on quiz passingScore (we'll just use 0.7 as default)
    const passed = score >= 0.7;

    const [attempt] = db
      .insert(schema.quizAttempts)
      .values({
        userId,
        quizId,
        score,
        passed,
        attemptedAt:
          typeof attemptedAt === "number" ? daysAgo(attemptedAt) : attemptedAt,
      })
      .returning()
      .all();

    // Build answer selections
    const questionIds = [...new Set(optionIds.map((o) => o.questionId))];
    for (let qi = 0; qi < questionIds.length; qi++) {
      const qId = questionIds[qi];
      const qOptions = optionIds.filter((o) => o.questionId === qId);
      let selectedOption: (typeof qOptions)[0];

      if (selectedCorrectIndices.includes(qi)) {
        // Pick correct answer
        selectedOption = qOptions.find((o) => o.correct)!;
      } else {
        // Pick wrong answer
        selectedOption = qOptions.find((o) => !o.correct)!;
      }

      db.insert(schema.quizAnswers)
        .values({
          attemptId: attempt.id,
          questionId: qId,
          selectedOptionId: selectedOption.optionId,
        })
        .run();
    }
  }

  // Olivia — passed the checks of module 1's first two lessons, which with
  // quiz 1 below masters the module (a badge Sarah sees in her roster).
  for (const i of [0, 1]) {
    const check = quizByLesson.get(course1LessonIds[i])!;
    recordQuizAttempt(students[2].id, check.id, check.optionIds, [0], 30 - i);
  }

  // Olivia — failed quiz 1 first attempt (1/3 correct), then passed on retry (3/3)
  recordQuizAttempt(students[2].id, quiz1.id, quiz1OptionIds, [0], 25);
  recordQuizAttempt(students[2].id, quiz1.id, quiz1OptionIds, [0, 1, 2], 24);

  // Olivia — passed quiz 3 (3/3 correct)
  recordQuizAttempt(students[2].id, quiz3.id, quiz3OptionIds, [0, 1, 2], 20);

  // Sophia — failed quiz 1 (1/3 correct, hasn't retaken yet)
  recordQuizAttempt(students[4].id, quiz1.id, quiz1OptionIds, [1], 10);

  console.log("Created quiz attempts and answers.");

  // ─── Badge demo progress ───
  // Streaks count UTC days with 2+ lessons that are both completed and have a
  // passed quiz, so these students finish quiz lessons at exact UTC moments.

  function allCorrectIndices(optionIds: QuizOptions) {
    const questionCount = new Set(optionIds.map((o) => o.questionId)).size;
    return Array.from({ length: questionCount }, (_, i) => i);
  }

  function finishQuizLesson(userId: number, lessonId: number, at: string) {
    const quiz = quizByLesson.get(lessonId)!;
    db.insert(schema.lessonProgress)
      .values({ userId, lessonId, status: LessonProgressStatus.Completed, completedAt: at })
      .run();
    recordQuizAttempt(userId, quiz.id, quiz.optionIds, allCorrectIndices(quiz.optionIds), at);
  }

  // Emma (students[0]) — the full collection. She finished all of course 1 and
  // the first 11 lessons of course 2, two quiz lessons a day for 15 consecutive
  // UTC days (30 to 16 days ago): course badge, every course 1 module mastered
  // and the 3-, 7- and 15-day streaks. Her streak has since lapsed.
  const emmaLessons = [...course1LessonIds, ...course2LessonIds.slice(0, 11)];
  // Quiz 3 took her two tries: a failed attempt (2/3) the day before.
  recordQuizAttempt(
    students[0].id,
    quiz3.id,
    quiz3OptionIds,
    [0, 2],
    utcDayAt(30 - Math.floor(emmaLessons.indexOf(course2LessonIds[2]) / 2) + 1, 12)
  );
  emmaLessons.forEach((lessonId, i) => {
    finishQuizLesson(students[0].id, lessonId, utcDayAt(30 - Math.floor(i / 2), i % 2 ? 15 : 10));
  });
  markInProgress(students[0].id, course2LessonIds[11]);

  // James (students[1]) — the live streak and module toasts. Modules 1-3 were
  // done one lesson every few days (no streak, but mastered). Then a 2-day
  // streak: module 4's first four lessons two days ago and yesterday, and one
  // lesson of module 5 today (1/2). Module 4's last lesson is still pending:
  // completing it and passing its quiz makes today 2/2 (3-day streak) and
  // masters module 4. Two lessons of module 5 stay open, so the course isn't
  // completed.
  for (let i = 0; i <= 10; i++) {
    finishQuizLesson(students[1].id, course1LessonIds[i], utcDayAt(44 - 3 * i, 10));
  }
  finishQuizLesson(students[1].id, course1LessonIds[11], utcDayAt(2, 10));
  finishQuizLesson(students[1].id, course1LessonIds[12], utcDayAt(2, 15));
  finishQuizLesson(students[1].id, course1LessonIds[13], utcDayAt(1, 10));
  finishQuizLesson(students[1].id, course1LessonIds[14], utcDayAt(1, 15));
  finishQuizLesson(students[1].id, course1LessonIds[16], utcDayAt(0, 0));
  markInProgress(students[1].id, course1LessonIds[15]);

  console.log("Created badge demo progress for Emma and James.");

  // ─── Video Watch Events ───
  // Sprinkle some realistic watch events

  function addWatchEvent(
    userId: number,
    lessonId: number,
    eventType: string,
    positionSeconds: number,
    eventDaysAgo: number
  ) {
    db.insert(schema.videoWatchEvents)
      .values({
        userId,
        lessonId,
        eventType,
        positionSeconds,
        createdAt: daysAgo(eventDaysAgo),
      })
      .run();
  }

  // Emma watching course 1 lesson 1 (8 min video)
  addWatchEvent(students[0].id, course1LessonIds[0], "play", 0, 50);
  addWatchEvent(students[0].id, course1LessonIds[0], "pause", 180, 50);
  addWatchEvent(students[0].id, course1LessonIds[0], "play", 180, 49);
  addWatchEvent(students[0].id, course1LessonIds[0], "ended", 480, 49);

  // James watching course 1 lesson 1
  addWatchEvent(students[1].id, course1LessonIds[0], "play", 0, 45);
  addWatchEvent(students[1].id, course1LessonIds[0], "ended", 480, 45);

  // Liam started watching course 2 lesson 1 but stopped mid-way
  addWatchEvent(students[3].id, course2LessonIds[0], "play", 0, 22);
  addWatchEvent(students[3].id, course2LessonIds[0], "pause", 300, 22);
  addWatchEvent(students[3].id, course2LessonIds[0], "seek", 150, 21);
  addWatchEvent(students[3].id, course2LessonIds[0], "play", 150, 21);
  addWatchEvent(students[3].id, course2LessonIds[0], "pause", 360, 21);

  console.log("Created video watch events.");

  // ─── Purchases ───
  // Individual purchases for enrolled students

  const [purchase1] = db
    .insert(schema.purchases)
    .values({
      userId: students[0].id, // Emma — bought course 1 individually
      courseId: course1.id,
      amountPaid: 4999,
      listPrice: 4999,
      quantity: 1,
      country: "US",
      createdAt: daysAgo(50),
    })
    .returning()
    .all();

  db.insert(schema.purchases)
    .values({
      userId: students[0].id, // Emma — bought course 2 individually
      courseId: course2.id,
      amountPaid: 5999,
      listPrice: 5999,
      quantity: 1,
      country: "US",
      createdAt: daysAgo(40),
    })
    .run();

  db.insert(schema.purchases)
    .values({
      userId: students[1].id, // James — bought course 1 with PPP discount (India)
      courseId: course1.id,
      amountPaid: 2500,
      listPrice: 4999,
      quantity: 1,
      country: "IN",
      createdAt: daysAgo(45),
    })
    .run();

  db.insert(schema.purchases)
    .values({
      userId: students[2].id, // Olivia — bought course 1 individually
      courseId: course1.id,
      amountPaid: 4999,
      listPrice: 4999,
      quantity: 1,
      country: "US",
      createdAt: daysAgo(35),
    })
    .run();

  db.insert(schema.purchases)
    .values({
      userId: students[4].id, // Sophia — bought course 1 individually
      courseId: course1.id,
      amountPaid: 4999,
      listPrice: 4999,
      quantity: 1,
      country: "US",
      createdAt: daysAgo(15),
    })
    .run();

  console.log("Created 5 individual purchases.");

  // ─── Teams, Team Members, and Coupons ───
  // Bossy McBossface bought 5 team seats for course 2; Olivia and Liam redeemed coupons

  const [team1] = db
    .insert(schema.teams)
    .values({ createdAt: daysAgo(30) })
    .returning()
    .all();

  db.insert(schema.teamMembers)
    .values({
      teamId: team1.id,
      userId: bossy.id,
      role: TeamMemberRole.Admin,
      createdAt: daysAgo(30),
    })
    .run();

  // Team purchase by Bossy McBossface for course 2 (5 seats)
  const [teamPurchase] = db
    .insert(schema.purchases)
    .values({
      userId: bossy.id,
      courseId: course2.id,
      amountPaid: 5999 * 5,
      listPrice: 5999,
      quantity: 5,
      country: "US",
      createdAt: daysAgo(30),
    })
    .returning()
    .all();

  // Generate 5 coupons for the team purchase
  const couponCodes = [
    "TEAM-NODEJS-A1B2C3",
    "TEAM-NODEJS-D4E5F6",
    "TEAM-NODEJS-G7H8I9",
    "TEAM-NODEJS-J0K1L2",
    "TEAM-NODEJS-M3N4O5",
  ];

  const seededCoupons = db
    .insert(schema.coupons)
    .values(
      couponCodes.map((code) => ({
        teamId: team1.id,
        courseId: course2.id,
        code,
        purchaseId: teamPurchase.id,
        createdAt: daysAgo(30),
      }))
    )
    .returning()
    .all();

  // Redeem 2 coupons: Olivia (students[2]) and Liam (students[3])
  // Olivia already has an enrollment for course 2 from the enrollments section above
  db.update(schema.coupons)
    .set({
      redeemedByUserId: students[2].id,
      redeemedAt: daysAgo(30),
    })
    .where(eq(schema.coupons.id, seededCoupons[0].id))
    .run();

  // Liam already has an enrollment for course 2 from the enrollments section above
  db.update(schema.coupons)
    .set({
      redeemedByUserId: students[3].id,
      redeemedAt: daysAgo(25),
    })
    .where(eq(schema.coupons.id, seededCoupons[1].id))
    .run();

  console.log(
    `Created 1 team with Bossy McBossface as admin, 1 team purchase, and ${seededCoupons.length} coupons (2 redeemed, 3 available).`
  );

  // ─── Analytics Demo Data ───
  // Extra students, individual and team purchases spread over ~90 days across
  // PPP tiers, lesson progress with realistic drop-off, and quiz attempts, so the
  // instructor analytics dashboard has something to show. A seeded PRNG keeps
  // the output identical on every run.

  const rand = mulberry32(20261031);
  const randInt = (min: number, max: number) =>
    min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rand() * items.length)];

  // Weighted so most buyers are full price, with a long tail of discounted tiers
  const buyerCountries = [
    ...["US", "US", "US", "US", "GB", "GB", "CA", "DE", "AU", "FR", "NL", "JP"], // tier 1
    ...["BR", "BR", "MX", "PL", "TR"], // tier 2
    ...["IN", "IN", "IN", "CO", "AR", "PH", "ZA"], // tier 3
    ...["NG", "PK", "EG", "KE"], // tier 4
  ] as const;

  const firstNames = [
    "Ava",
    "Noah",
    "Mia",
    "Lucas",
    "Zoe",
    "Ethan",
    "Chloe",
    "Mateo",
    "Aria",
    "Leo",
    "Nora",
    "Kai",
    "Isla",
    "Omar",
    "Priya",
    "Diego",
    "Yuki",
    "Amara",
    "Felix",
    "Hana",
    "Ravi",
    "Lena",
    "Tariq",
    "Sofia",
    "Jonas",
    "Ines",
  ];
  const lastNames = [
    "Garcia",
    "Nguyen",
    "Patel",
    "Kim",
    "Okafor",
    "Silva",
    "Müller",
    "Rossi",
    "Kowalski",
    "Haddad",
    "Tanaka",
    "Mensah",
    "Novak",
    "Reyes",
    "Singh",
    "Ahmed",
    "Larsen",
    "Dubois",
  ];

  let demoUserCount = 0;
  function createDemoStudent(joinedDaysAgo: number) {
    demoUserCount++;
    const first = pick(firstNames);
    const last = pick(lastNames);
    const [user] = db
      .insert(schema.users)
      .values({
        name: `${first} ${last}`,
        email: `${slugify(`${first}.${last}`)}.${demoUserCount}@student.dev`,
        role: UserRole.Student,
        avatarUrl: `https://api.dicebear.com/9.x/avataaars/svg?seed=demo${demoUserCount}`,
        createdAt: daysAgo(joinedDaysAgo),
      })
      .returning()
      .all();
    return user;
  }

  type QuizSeed = {
    id: number;
    optionIds: { questionId: number; optionId: number; correct: boolean }[];
    passRate: number;
  };

  type CourseSeed = {
    id: number;
    price: number;
    lessonIds: number[];
    // Index of the lesson where many students give up
    steepDropIndex: number;
    quizzesByLessonId: Map<number, QuizSeed>;
  };

  const demoCourses: CourseSeed[] = [
    {
      id: course1.id,
      price: course1.price,
      lessonIds: course1LessonIds,
      // "Function Types" (module 3, lesson 1), just before the hard generics quiz
      steepDropIndex: 7,
      quizzesByLessonId: new Map([
        [
          course1LessonIds[2],
          { id: quiz1.id, optionIds: quiz1OptionIds, passRate: 0.8 },
        ],
        [
          course1LessonIds[7],
          { id: quiz2.id, optionIds: quiz2OptionIds, passRate: 0.6 },
        ],
      ]),
    },
    {
      id: course2.id,
      price: course2.price,
      lessonIds: course2LessonIds,
      steepDropIndex: 12,
      quizzesByLessonId: new Map([
        [
          course2LessonIds[2],
          { id: quiz3.id, optionIds: quiz3OptionIds, passRate: 0.75 },
        ],
      ]),
    },
  ];

  // Enrolls a student and walks them through the course until they drop off.
  // Each lesson is completed with high probability, except the steep-drop lesson.
  // Students can't progress faster than about one lesson per day since enrolling.
  function enrollWithProgress(
    userId: number,
    course: CourseSeed,
    enrolledDaysAgo: number
  ) {
    const maxLessons = Math.min(course.lessonIds.length, enrolledDaysAgo + 1);
    let completed = 0;
    let lastCompletedDay = enrolledDaysAgo;

    for (let i = 0; i < maxLessons; i++) {
      const lessonId = course.lessonIds[i];
      const day = Math.max(
        0,
        enrolledDaysAgo -
          Math.ceil(((i + 1) * enrolledDaysAgo) / (maxLessons + 2))
      );

      const quiz = course.quizzesByLessonId.get(lessonId);
      let quizPassed = true;
      if (quiz) {
        quizPassed = rand() < quiz.passRate;
        recordQuizAttempt(
          userId,
          quiz.id,
          quiz.optionIds,
          quizPassed ? allCorrect(quiz) : [0],
          day
        );
      }

      const continueChance = i === course.steepDropIndex ? 0.55 : 0.93;
      if (!quizPassed || rand() >= continueChance) {
        // Reached this lesson but stopped here
        markInProgress(userId, lessonId);
        break;
      }

      markComplete(userId, lessonId, day);
      completed++;
      lastCompletedDay = day;
    }

    const finished = completed === course.lessonIds.length;
    db.insert(schema.enrollments)
      .values({
        userId,
        courseId: course.id,
        enrolledAt: daysAgo(enrolledDaysAgo),
        completedAt: finished ? daysAgo(lastCompletedDay) : null,
      })
      .run();
  }

  function allCorrect(quiz: QuizSeed) {
    const questionCount = new Set(quiz.optionIds.map((o) => o.questionId)).size;
    return Array.from({ length: questionCount }, (_, i) => i);
  }

  // Individual purchases: ~30 new buyers per course, a few buying both
  let demoIndividualPurchases = 0;
  for (const course of demoCourses) {
    for (let n = 0; n < 30; n++) {
      const purchasedDaysAgo = randInt(0, 89);
      const country = pick(buyerCountries);
      const student = createDemoStudent(purchasedDaysAgo + randInt(0, 10));

      const buy = (c: CourseSeed, dayAgo: number) => {
        db.insert(schema.purchases)
          .values({
            userId: student.id,
            courseId: c.id,
            amountPaid: calculatePppPrice(c.price, country),
            listPrice: c.price,
            quantity: 1,
            country,
            createdAt: daysAgo(dayAgo),
          })
          .run();
        enrollWithProgress(student.id, c, dayAgo);
        demoIndividualPurchases++;
      };

      buy(course, purchasedDaysAgo);
      if (rand() < 0.15) {
        const other = demoCourses.find((c) => c.id !== course.id)!;
        buy(other, randInt(0, purchasedDaysAgo));
      }
    }
  }

  // Team purchases: one buyer per team, some seats redeemed by new students
  const demoTeamPurchases = [
    {
      course: demoCourses[0],
      daysAgo: 82,
      seats: 8,
      country: "US",
      redeemed: 6,
    },
    {
      course: demoCourses[0],
      daysAgo: 41,
      seats: 4,
      country: "BR",
      redeemed: 3,
    },
    {
      course: demoCourses[0],
      daysAgo: 9,
      seats: 10,
      country: "IN",
      redeemed: 4,
    },
    {
      course: demoCourses[1],
      daysAgo: 67,
      seats: 6,
      country: "DE",
      redeemed: 5,
    },
    {
      course: demoCourses[1],
      daysAgo: 20,
      seats: 3,
      country: "NG",
      redeemed: 2,
    },
    {
      course: demoCourses[1],
      daysAgo: 4,
      seats: 12,
      country: "GB",
      redeemed: 3,
    },
  ];

  let demoCoupons = 0;
  for (const tp of demoTeamPurchases) {
    const buyer = createDemoStudent(tp.daysAgo + 5);
    const [team] = db
      .insert(schema.teams)
      .values({ createdAt: daysAgo(tp.daysAgo) })
      .returning()
      .all();
    db.insert(schema.teamMembers)
      .values({
        teamId: team.id,
        userId: buyer.id,
        role: TeamMemberRole.Admin,
        createdAt: daysAgo(tp.daysAgo),
      })
      .run();

    const [purchase] = db
      .insert(schema.purchases)
      .values({
        userId: buyer.id,
        courseId: tp.course.id,
        amountPaid: calculatePppPrice(tp.course.price, tp.country) * tp.seats,
        listPrice: tp.course.price,
        quantity: tp.seats,
        country: tp.country,
        createdAt: daysAgo(tp.daysAgo),
      })
      .returning()
      .all();

    for (let s = 0; s < tp.seats; s++) {
      demoCoupons++;
      const redeemer =
        s < tp.redeemed ? createDemoStudent(tp.daysAgo + randInt(0, 5)) : null;
      const redeemedDaysAgo = redeemer
        ? Math.max(0, tp.daysAgo - randInt(0, 5))
        : null;

      db.insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: tp.course.id,
          code: `TEAM-DEMO-${String(demoCoupons).padStart(4, "0")}`,
          purchaseId: purchase.id,
          redeemedByUserId: redeemer?.id ?? null,
          redeemedAt:
            redeemedDaysAgo === null ? null : daysAgo(redeemedDaysAgo),
          createdAt: daysAgo(tp.daysAgo),
        })
        .run();

      if (redeemer && redeemedDaysAgo !== null) {
        enrollWithProgress(redeemer.id, tp.course, redeemedDaysAgo);
      }
    }
  }

  console.log(
    `Created analytics demo data: ${demoUserCount} students, ${demoIndividualPurchases} individual purchases, ${demoTeamPurchases.length} team purchases (${demoCoupons} seats).`
  );

  // ─── Badges ───
  // Awarded from the progress above with the same logic a backfill uses, so
  // dates are historical and every badge starts unseen.
  for (const user of db.select({ id: schema.users.id }).from(schema.users).all()) {
    evaluateBadgesForUser(user.id);
  }
  // Emma saw her streak badges back when she earned them; the course and
  // module badges are still "New".
  db.update(schema.userBadges)
    .set({ seenAt: daysAgo(15) })
    .where(
      and(
        eq(schema.userBadges.userId, students[0].id),
        eq(schema.userBadges.type, BadgeType.Streak)
      )
    )
    .run();

  const count = (table: string) =>
    (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;

  console.log("\n✓ Seed complete!");
  console.log(`  Users: ${count("users")}`);
  console.log("  Categories: 5");
  console.log(
    `  Courses: 2 (${course1LessonIds.length} + ${course2LessonIds.length} lessons)`
  );
  console.log(`  Quizzes: ${count("quizzes")}`);
  console.log(`  Quiz attempts: ${count("quiz_attempts")}`);
  console.log(`  Enrollments: ${count("enrollments")}`);
  console.log(`  Lesson progress: ${count("lesson_progress")}`);
  console.log(
    `  Purchases: ${count("purchases")} (${count("purchases WHERE id NOT IN (SELECT purchase_id FROM coupons)")} individual + ${count("purchases WHERE id IN (SELECT purchase_id FROM coupons)")} team)`
  );
  console.log(`  Teams: ${count("teams")} (with ${count("coupons")} coupons)`);
  console.log(`  Badges: ${count("user_badges")}`);
}

// Small deterministic PRNG so the seed produces the same data on every run
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

seed().catch(console.error);
