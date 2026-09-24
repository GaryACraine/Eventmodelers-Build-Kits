# Course Manager — DCB Event Store Demo

A vertical-slice demo application built with the [DCB Event Store](https://github.com/kraken-tech/dcb-event-store).

## Prerequisites

This scaffold uses local file: references to the DCB packages. Clone the dcb-event-store repo **as a sibling** to this project:

```
parent-dir/
├── dcb-event-store/     ← https://github.com/kraken-tech/dcb-event-store
└── your-project/        ← this project
```

```bash
git clone https://github.com/kraken-tech/dcb-event-store ../dcb-event-store
cd ../dcb-event-store && pnpm install && pnpm build
```

> Once the `@dcb-es/*` packages are published to npm, replace the `file:` references in `package.json` with npm version pins.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres
docker compose up -d

# 3. Run tests (requires Docker for testcontainers)
npm test

# 4. Build
npm run build

# 5. Start the server
PG_CONNECTION_STRING=postgresql://dcb:dcb@localhost:5432/dcb npm start

# 6. Seed demo data
BASE_URL=http://localhost:3000 node dist/seed.js
```

## Frontend (`web/`)

A React app next to the backend, built by the loop from each slice's screen (see [web/README.md](web/README.md)):

```bash
cd web && npm install && cd ..
npm run gen:api     # typed client from the code's routes: no database or running backend needed
cd web
npm run dev         # http://localhost:5173 (start the backend with CORS_ORIGIN=http://localhost:5173)
npm run dev:mock    # no backend: mock responses from the scenarios
```

The example app has a frontend too: Course Form (`/courses/new`), Courses (`/courses`), Course Page
(`/courses/:courseId`) and My Courses (`/my-courses`), in `web/src/pages/` and `web/src/slices/`. It's the pattern
the `build-screen` skill copies. `scripts/start-empty.sh` removes it with the example backend.

## API

Once running, visit `http://localhost:3000/openapi.json` for the full OpenAPI document. Each slice registers its
own routes (`src/shared/openapi.ts`), so the document grows as slices are built.

A browser app on another origin (the `web/` frontend, Vite's dev server on `:5173`) needs `CORS_ORIGIN`: a
comma-separated list of allowed origins, or `*`. Unset, the API sends no CORS headers.

Routes are named after the model (ADR-025): a command is `POST /<command>` with every field in the body
(204 + `ETag`, or 201 with the generated fields), a read model `GET /<read-model>/:<id>`, a query
`GET /<read-model>/<query>?<parameters>`. The app's page routes are separate and entity-shaped.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register-course` | Register a course |
| `POST` | `/register-student` | Register a student |
| `POST` | `/subscribe-student-to-course` | Subscribe a student |
| `POST` | `/unsubscribe-student-from-course` | Unsubscribe a student |
| `POST` | `/change-course-capacity` | Change course capacity |
| `GET` | `/course-list` | List courses (paginated) |
| `GET` | `/course-details/:courseId` | Get course details |
| `GET` | `/student-details/:studentId` | Get student details |
| `GET` | `/events` | SSE event feed |
| `GET` | `/openapi.json` | OpenAPI document |

## Architecture

Each feature is a vertical slice under `src/contexts/{context}/slices/{slicename}/`:

**Write slices** (command → events):
- `command.ts` — command type
- `decisionModels.ts` — `EventHandlerWithState` decision models (tag-scoped state)
- `decider.ts` — `decider()` combining models + business logic
- `schema.ts` — Zod request validation, and the route's `/openapi.json` entry (`registerCommand`)
- `route.ts` — Express route using `handle()`, `validateBody()`, `withETag()`
- `route.tests.ts` — `ApiSpecification` unit tests (in-memory store)

**Read slices** (events → projection → query):
- `projection.ts` — `pongoProjection()` (Pongo/JSONB collections)
- `schema.ts` — the response body's Zod schema, and the route's `/openapi.json` entry (`registerRead`)
- `route.ts` — Express GET with `preferWait` middleware
- `route.tests.ts` — Postgres integration tests via testcontainers

Shared events: `src/contexts/{context}/Events.ts`
