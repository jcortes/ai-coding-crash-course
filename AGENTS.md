## Architecture

- **Routes** are registered explicitly in `app/routes.ts`; adding a file under `app/routes/` does nothing until it is listed there. Route modules import their types from `./+types/<route-name>`.
- **Services**: data access lives in `app/services/*Service.ts`. Route loaders and actions call service functions to get data, and new queries go into a service.
- **`app/db/index.ts`** opens the connection lazily behind a Proxy so that the module stays side-effect free and Rollup can tree-shake `better-sqlite3` out of the client bundle. Keep this file side-effect free.
- **Tests** are service-level. Each test file uses `vi.mock("~/db", ...)` to swap in `createTestDb()`, an in-memory DB built from the `drizzle/` migrations, and fills it with `seedBaseData()` from `app/test/setup.ts`. Copy the pattern from an existing `*.test.ts`.
- **Auth** is a cookie session that stores `userId` (`app/lib/session.ts`). There are no passwords. In dev, users and the country (which drives PPP pricing in `app/lib/ppp.ts`) are switched through `app/components/dev-ui.tsx` and `api/switch-user` / `api/set-dev-country`.

