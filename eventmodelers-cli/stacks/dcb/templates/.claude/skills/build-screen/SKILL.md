---
name: build-screen
description: Builds a slice's screen in web/ (React) from slice.json's screens[] — a form per submitted command, a view per displayed read model, MSW handlers and tests from the scenarios — and puts it on its page
---

# Build Screen (DCB `web/`)

> Read the slice definition from `.build-kit/.slices/{context}/{slicename}/slice.json` first. It is the **source
> of truth**: the screen's contract, its mockup, its page, the fields, the API paths and the scenario examples all
> come from it. Never invent a field, a value, a message or a page.

A slice with a screen gets its UI **after** its backend: the slice's routes exist, are in `/openapi.json`, and
their tests pass. This skill touches `web/` only, and one slice at a time.

The reference is the kit's example app: `web/src/slices/{register-course,course-list,course-details,
subscribe-student,student-details}/` and `web/src/pages/` (Course Form, Courses, Course Page, My Courses), built
from the screens in `tests/enrollment-proof/slices/*/slice.json`. Copy its patterns.

---

## What slice.json gives you

Each `screens[]` entry with a `mockup` is one screen card:

| Where | What it decides |
|---|---|
| `dependencies` with `connectionType: "submits"` (OUTBOUND, COMMAND) | a **form** per command |
| `dependencies` with `connectionType: "displays"` (INBOUND, READMODEL) | a **view** per read model |
| `mockup.html` | the markup, 1:1: elements, classes, headings, labels, button text |
| `page` = `{ title, route, params, slices }` | the page this card is part of, its client route, where each ID comes from, and the slices that make it up (timeline order) |
| `commands[]` / `readmodels[]` | fields, `apiEndpoint` (the API path), `readModelType`, `queries` |
| `specifications[]` | the examples for mock data and tests, and the rejections the screen shows |

**Only this slice's part.** Build a form or view only for a command or read model that is in this slice's
`commands[]` / `readmodels[]`. A dependency on another slice's read model is the context around a part (in the
mockup, a `data-slice="…"` region): that slice builds it, and the page shows it. Skip it.

**Two kinds of route, never mixed:**
- `page.route` (`/courses/:courseId`) is the URL people see. Only the page file uses it.
- `apiEndpoint` (`/course-details/{courseId}`, `/subscribe-student`) is what the code calls, through
  `web/src/lib/api.ts`. The two share ID names only: the `:courseId` of the route is the `courseId` sent to the API.

## Files

```
web/src/slices/{slicename}/          ← the slice's folder name in .build-kit/.slices/{context}/{slicename}/
├── {Command}Form.tsx                  one per submitted command
├── {ReadModel}View.tsx                one per displayed read model (a list: {ReadModel}.tsx / {Query}List.tsx)
├── handlers.ts                        MSW handlers for every API path the slice's components call
└── *.test.tsx                         a test file per component, a test per specification
web/src/pages/{PageTitle}.tsx          the page (PascalCase of page.title), created or extended
web/src/pages/{PageTitle}.test.tsx     the page put together
web/src/lib/api-types.ts               regenerated, never edited
```

An **extension** slice (`extends` in slice.json) builds its backend in its origin's folder, but its screen is its
own: `web/src/slices/{its own slicename}/`.

Nothing else changes: not `App.tsx`, `Layout.tsx`, `routes.tsx` (it finds pages itself), `src/lib/*` (but
`api-types.ts`), `src/mocks/*` (they find `handlers.ts` themselves), `src/components/ui/*`, config or any
`package.json`. The commit guard rejects it (`web-scope`). If the screen can't be built without such a change (a
missing shadcn component, a library), invoke `request-feedback` and stop.

---

## Step 1 — Types

The client is typed from the backend's `/openapi.json`. Regenerate it so this slice's new paths are in it:

```bash
curl -sf http://localhost:${PORT:-3000}/openapi.json > /dev/null   # is the backend up?
cd web && npm run gen:api                                          # API_URL=… for another address
```

If the backend isn't running: `npm run db:start`, `npm run build`, start it in the background with `npm start`,
run `gen:api`, then stop it. Check that `web/src/lib/api-types.ts` now has every `apiEndpoint` of this slice. Body
and response types come from it: `components["schemas"]["<name>"]`, the name the slice's `schema.ts` gave its
Zod object with `.openapi("…")`.

## Step 2 — A form per submitted command

Where each field of the command comes from:

| The field | In the form |
|---|---|
| bound by a visible `data-field` input in the mockup | typed: a React Hook Form input, validated by Zod |
| bound by `<input type="hidden" data-field="…">` | a prop: the page has it (a route param, `page.params` `from: "route"`) |
| `mapping: "session:<key>"` | `useSession()[key]` (the page is behind `RequireSession`) |
| `generated: true` | not sent: the backend makes it, and a 201 returns it |

Every field that is sent goes in the body: `POST {apiEndpoint}` with the whole command, never an ID in the path
(ADR-025).

```tsx
type RegisterCourse = components["schemas"]["RegisterCourseBody"]

/** registerCourse's fields (slice.json), checked against the body the backend documents. */
const RegisterCourseSchema = z.object({
    id: z.string().trim().min(1, "Required"),
    title: z.string().trim().min(1, "Required"),
    capacity: z.number({ error: "Required" }).int().min(1, "At least 1")
}) satisfies z.ZodType<RegisterCourse>
```

- One Zod entry per **typed** field: `String` → `z.string().trim().min(1, "Required")`, `Int`/`Long` →
  `z.number({ error: "Required" }).int()` with `register(name, { valueAsNumber: true })`, `Boolean` → a checkbox,
  `optional: true` → `.optional()`. Add the constraints the slice's backend `schema.ts` enforces (`.min(1)`), so a
  400 scenario is caught before anything is sent. `satisfies z.ZodType<Body>` when every body field is typed.
- `useForm({ resolver: zodResolver(Schema) })`. A form with nothing typed (only props and session) is a plain
  `<form onSubmit>` with `useState` for sending / done / error.
- Submit:
  ```tsx
  const { position } = await command(api.POST("/register-course", { body }))
  await recordWrite(position)          // useWrites(): refetches the views, remembers the position
  onRegistered?.(body)                 // a callback prop for the page (e.g. go to the new course)
  ```
  A 201's generated fields are `command(...).data`: pass them to the callback.
- A rejection is an `ApiError` carrying the backend's Problem-JSON `detail`: show `error.message` in a
  `<p role="alert">` (RHF: `setError("root", { message })`). A field error shows under its input.
- Ids and labels: `id="{command}-{field}"`, `<Label htmlFor>` with the mockup's label text.

## Step 3 — A view per displayed read model

```tsx
const { afterLastWrite } = useWrites()
const course = useQuery({
    queryKey: ["course-details", courseId],
    queryFn: () => read(api.GET("/course-details/{courseId}", { params: { path: { courseId } }, headers: afterLastWrite() }))
})
if (course.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>
if (course.isError) return <p role="alert">{course.error.message}</p>
```

- **Read-your-writes, by `readModelType`:** absent or `database-projected` (async) → `headers: afterLastWrite()`.
  `inline-projected` and `live-report` are current when the command returns: **no headers**.
- The key (`/{courseId}`) is a prop: the page passes its route param or the session value, whichever
  `page.params` names.
- A query parameter the mockup has no input for is fixed at its slice.json example (`minRemainingSeats: 1` for
  "available courses"), as a named constant with a comment saying so.
- A `data-list` naming a **query** of the read model, or a list read model (`listElement`), is a **paged list**
  (ADR-026): `usePagedList` (`src/lib/paging.ts`) fetches a page at a time with `limit` and `cursor` beside the
  query's own parameters in `params.query`, `rows` are the pages so far, and `<LoadMore list={…} />`
  (`src/components/LoadMore.tsx`) goes under them:
  ```tsx
  const courses = usePagedList({
      queryKey: ["course-seats", "available-courses", minRemainingSeats],
      fetchPage: ({ limit, cursor }) =>
          read(api.GET("/course-seats/available-courses", {
              params: { query: { minRemainingSeats, limit, cursor } },
              headers: afterLastWrite()          // async read models only, as for any view
          }))
  })
  // … {courses.rows.map(…)} … <LoadMore list={courses} />
  ```
  A `data-list` naming a `List` field comes whole with its document: `.map` over that field, no paging.
- A list row that should open another page gets a `linkTo` prop (`(row) => string`) from the page. The view never
  knows page routes.
- `queryKey`: the read model's kebab name, then its key or query name and parameters.

## Step 4 — The mockup, 1:1

The mockup is the markup. For each part this slice builds, take its region of `mockup.html` and write it as JSX:

- keep the elements, their order, `class` → `className`, headings, labels, button text and static words
  ("places", "Signed in as");
- drop every `data-*` attribute and the example values: a `data-field` element shows the data, a `data-list`
  repeats its first item per row (`key` = the row's ID attribute);
- inputs become `<Input>` / `<Label>`, buttons `<Button>` (`src/components/ui/`), a `form` keeps `mock-card`;
- add only what behaviour needs: loading, the alert, a field error, a success `role="status"` line, an empty-list
  line.

## Step 5 — Mock data: `handlers.ts`

```ts
export const handlers = [
    http.get(apiUrl("/course-details/:courseId"), ({ params }) =>
        params.courseId === "c1"
            ? HttpResponse.json({ id: "c1", title: "Math", capacity: 30, subscribedStudents: [] }, { headers: { ETag: '"2"' } })
            : HttpResponse.json({ status: 404, title: "Not Found", detail: "Course not found" }, { status: 404 })
    )
]
```

- One handler per API path the slice's components call (MSW path syntax: `:param`), answered with the **happy
  path** of the specifications: the examples of the first success scenario, in the response shape of
  `api-types.ts` (a field the scenario leaves out takes its field example). A keyed read answers its example key;
  any other key gets the backend's 404 (the route's `notFound` message).
- A paged list answers through `page(rows, request)` (`src/mocks/paging.ts`), which pages the scenario rows the
  way the backend does: `HttpResponse.json(page(rows, request))`.
- A command answers 204 with an `ETag` (201 with the generated fields when it has any).
- Rejections are not in `handlers.ts` (mock mode shows the happy path); the tests answer them.
- Values come only from slice.json examples. `src/mocks/handlers.ts` finds the file itself.

## Step 6 — Tests: one per specification

A test file per component, `describe("{slice title}")`, rendered with `renderWithProviders(ui, { session })`
(`src/test/render.tsx`), requests answered by MSW:

| Specification | Test |
|---|---|
| a success (`then` an event, or a read model) | the form sends exactly the example body (capture it in `server.use`), or the view shows the example values |
| a rejection (`then` `SPEC_ERROR` 404/409/422) | `server.use(...)` answers the Problem-JSON with the backend's **own message** (read it in the slice's `decider.ts` / route), and the alert shows it |
| a 400 for a typed field | fill the form without it (or with the invalid value): the field's message shows, and nothing is sent |
| one the screen can't produce (a 400 for a session or route value) | no test; a comment naming the specification and why |

Every paged list also gets **"Load more adds the next page"**: `server.use(...)` answers the first request (no
`cursor`) with a row and a cursor, and the request with that cursor with another row and none; the test clicks
Load more, sees both rows, and sees the button gone.

## Step 7 — The page

`page.title` → `web/src/pages/{PascalCase}.tsx`. Another slice on the same page may have created it already.

- **New page:**
  ```tsx
  // slice.json screens[].page: "Course Page", from the slices "Course Details" and "Subscribe Student";
  // params: courseId from the route, studentId from the session.
  export const page: PageInfo = { path: "/courses/:courseId", title: "Course Page", session: ["studentId"] }

  export default function CoursePage() {
      const { courseId } = useParams<"courseId">()
      return (
          <>
              <CourseDetailsView courseId={courseId!} />
              <SubscribeStudentForm courseId={courseId!} />
          </>
      )
  }
  ```
  `path` = `page.route`; `session` = the `page.params` with `from: "session"` (omit if none); `nav: true` when the
  route has no `:param`.
- **Existing page:** add this slice's part, leave the other parts alone, and bring `page` in line with slice.json
  if the route or params changed.
- **Order of the parts:** as the mockups show them. A card whose mockup wraps a neighbouring slice's region
  (`data-slice`) around its own part puts that neighbour where the region is (Course Page: the course details
  above the Subscribe button). Otherwise, `page.slices` order.
- The page wires things together: route params (`useParams`) and session values (`useSession`) become props;
  callbacks go where people expect (a create form navigates to the new entity's page, if a page with that `:id`
  exists; a list's `linkTo` points at it). A page's own heading from the mockup (`<h1>` outside any part) lives
  here.
- **A new page with `:id`:** the pages already built that list or create that entity now lead to it: give their
  list a `linkTo` and their create form an `onCreated` navigation (`generatePath(route, { id })`), and update their
  page tests. Only page files change for this, never another slice's folder.
- `{PageTitle}.test.tsx`: `render(<App initialPath="…" session={…} />)` shows the page at its route with this
  slice's part, and the flow the page exists for (submit → the view updates, a row → its page).

## Step 8 — Verify, check, commit

1. **Against slice.json:** every field the forms send and the views show is in slice.json; every rejection test
   uses a message the backend really sends; every `api.GET`/`api.POST` path is an `apiEndpoint` of this slice.
2. `cd web && npx tsc -b && npx vitest run src/slices/{slicename} src/pages`.
3. Commit the screen on its own (the backend is already committed):
   ```bash
   git add web/src/slices/{slicename} web/src/pages web/src/lib/api-types.ts
   git commit -m "feat: [Slice Name] screen"
   ```
   The pre-commit guard runs `blocked-paths`, `web-scope` (only these paths, one slice, tests present) and
   `web-tests` (typecheck, the slice's and the pages' tests).
