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

## API

Once running, visit `http://localhost:3000/openapi.json` for the full OpenAPI document. Each slice registers its
own routes (`src/shared/openapi.ts`), so the document grows as slices are built.

A browser app on another origin (the `web/` frontend, Vite's dev server on `:5173`) needs `CORS_ORIGIN`: a
comma-separated list of allowed origins, or `*`. Unset, the API sends no CORS headers.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/courses` | Register a course |
| `POST` | `/students` | Register a student |
| `POST` | `/courses/:courseId/subscriptions` | Subscribe a student |
| `DELETE` | `/courses/:courseId/subscriptions/:studentId` | Unsubscribe a student |
| `PUT` | `/courses/:courseId/capacity` | Change course capacity |
| `GET` | `/courses` | List courses (paginated) |
| `GET` | `/courses/:courseId` | Get course details |
| `GET` | `/students/:studentId` | Get student details |
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
