---
name: build-screen
description: Builds a slice's screen in web/ (React) from slice.json's screens[] — a form per submitted command, a view per displayed read model, MSW handlers and tests from the scenarios — and exports them as the slice's parts (index.ts). The page is the model's (navigation.json, ADR-069): never written or edited here
---

# Build Screen (DCB `web/`)

> Read the slice definition from `.build-kit/.slices/{context}/{slicename}/slice.json` first. It is the **source
> of truth**: the screen's contract, its mockup, its page, the fields, the API paths and the scenario examples all
> come from it. Never invent a field, a value, a message or a page.

A slice's UI is built against the **API contract**, `api/openapi.json`, which the model's export writes (ADR-029):
every route, field and rejection the model has, whether or not its backend is built yet. So the backend may not
exist when this runs; nothing here needs it. This skill touches `web/` only, and one slice at a time. The loop runs
it as the slice's **UI job** (`concerns.ui`, `lib/screen-prompt.md`). With `buildScreen` in
slice.json, the screen of a built slice was added or changed (see "A screen added or changed" at the end). When
the job ends, its concern's status is set in `index.json`: `concerns.ui` Done, or Blocked with the reason.

The reference is the kit's example app: `web/src/slices/{register-course,course-list,course-details,
subscribe-student,student-details}/`, each exporting its parts from `index.ts`, built from the screens in
`tests/enrollment-proof/slices/*/slice.json`; its pages are `web/src/navigation.json`. Copy its patterns.

**A part is put together from the kit's patterns (ADR-072), never restyled by hand.** `@/components/patterns`
holds every piece parts share, each with its states and accessibility built in: `ViewCard` (a read's loading, still
updating, empty and error states), `FormCard` (the error first and focused, sending, done, confirm), `Field` and
`ChoiceGroup` (labels, hints, errors named by their inputs), `SummaryList` (key facts), `DataTable` (rows named,
actions column, empty, Load more), `RowAction` (a row's command, named by its row) and `Value` (dates, money, codes,
lists by type). A part writes the mockup's words and order with these, and never its own alert, status line, read
states, `<table>`, `<dl>`, `<fieldset>`, inline style or colour: the commit check `web-patterns` refuses them, naming
the pattern. The patterns are the kit's: never edit `src/components/` (`web-scope`). A part no pattern fits: block
with `request-feedback`.

**The page is never yours (ADR-069).** emcli writes each page's parts into `web/src/navigation.json` at export, and
the kit's `ModelPage` (`src/lib/model-page.tsx`) renders them: the order, who sees each part, the ids it gets, the
forms in a list's rows, where the person goes after a command, the heading. This skill builds the slice's parts and
exports them; nothing else. `emcli navigation` (or `navigation.json`) shows the page this slice's parts are on.

---

## What slice.json gives you

Each `screens[]` entry with a `mockup` is one screen card:

| Where | What it decides |
|---|---|
| `dependencies` with `connectionType: "submits"` (OUTBOUND, COMMAND) | a **form** per command |
| `dependencies` with `connectionType: "displays"` (INBOUND, READMODEL) | a **view** per read model |
| `mockup.html` | the markup, 1:1: elements, classes, headings, labels, button text |
| `page` = `{ title, route, params, slices }` | the page this card is part of, and where each ID comes from (the page gives them as props) |
| `next` = `{ title, context, route, params, on }` | where the page goes once this card's command (`on`) succeeds: the page does it, after the form's `onDone` |
| `commands[]` / `readmodels[]` | fields, `apiEndpoint` (the API path), `readModelType`, `queries` |
| `specifications[]` | the examples for mock data and tests, and the rejections the screen shows |

**Only this slice's part.** Build a form or view only for a command or read model that is in this slice's
`commands[]` / `readmodels[]`. A dependency on another slice's read model is the context around a part (in the
mockup, a `data-slice="…"` region): that slice builds it, and the page shows it. Skip it.

**An external read model** (`context: "EXTERNAL"`, with an `externalSystem`) is held by that system, not by our
API (ADR-052). Never fetch it, and write no view, MSW handler or API type for it: it has no `apiEndpoint`. Its
fields come from that system's client in the browser. For the sign-in provider (`Auth`), that's the session:
`useSession()[field]`. A command never sends its `session:` fields, and a read model keyed by the signed-in person
(`/my-account`, no key in its `apiEndpoint`) is fetched with no key: the API takes both from the token (ADR-055 part 2).

**A screen another system serves** (`externalSystem` on the screen, ADR-057), such as the sign-in screens, is never
yours to build: emcli makes no job for it, and the kit's scaffold provides Sign In, Sign Up and "check your email"
(`provider-better-auth`). A page that needs someone signed in reads the session, as above. A mockup's
`<!-- @import account-header -->` is the app's header (`Layout.tsx`, who is signed in and Sign out): never build it
into the page.

**Two kinds of route, never mixed:**
- `page.route` (`/courses/:courseId`) is the URL people see. Only the kit's page uses it; a part never does.
- `apiEndpoint` (`/course-details/{courseId}`, `/subscribe-student`) is what the code calls, through
  `web/src/lib/api.ts`. The two share ID names only: the `:courseId` of the route is the `courseId` sent to the API.

## Files

```
web/src/slices/{slicename}/          ← the slice's folder name in .build-kit/.slices/{context}/{slicename}/
├── {Command}Form.tsx                  one per submitted command
├── {ReadModel}View.tsx                one per displayed read model
├── index.ts                           the slice's parts, by the names navigation.json gives (Step 7)
├── handlers.ts                        MSW handlers for every API path the slice's components call
└── *.test.tsx                         a test file per component, a test per specification
web/src/lib/api-types.ts               regenerated, never edited
web/src/providers/{name}/              another system's browser library behind a module of ours (ADR-044): only when
                                       the slice names that system, as its provider skill says
```

An **extension** slice (`extends` in slice.json) builds its backend in its origin's folder, but its screen is its
own: `web/src/slices/{its own slicename}/`.

Nothing else changes: never a page (`src/pages/`, `src/navigation.json`: the model's), not `App.tsx`,
`Layout.tsx`, `routes.tsx`, `src/lib/*` (but `api-types.ts`), `src/mocks/*` (they find `handlers.ts` themselves),
`src/components/*` (the ui atoms and the patterns), config or any `package.json`. The commit guard rejects it
(`web-scope`). If the screen can't be built without such a change (a missing pattern or shadcn component, a library,
a page that needs more than its parts), invoke
`request-feedback` and stop: the model or the kit changes, not the page.

---

## Step 1 — Types

The client is typed from the API contract, `api/openapi.json`. Regenerate the types from it, so this slice's
paths are in them. No backend is involved:

```bash
npm run gen:api        # from the project root: api/openapi.json → web/src/lib/api-types.ts
```

Check that `web/src/lib/api-types.ts` now has every `apiEndpoint` of this slice. If one is missing, the contract is
older than the slice: stop and set the job to Blocked ("api/openapi.json lacks <path>: export the model again").
Never edit the contract or the types (the `api-types` check compares them). Body and response types come from
it: `components["schemas"]["<Command>Body"]` for a command, `components["schemas"]["<ReadModel>"]` for a read model.
A read model's type is its final shape, with what its extensions add (optional, since a document folded before one
lacks it); slice.json's `readmodels[]` holds only this slice's fields. A mockup binding a field the contract has
and slice.json doesn't (a name an extension adds) is right: show it, and leave the cell empty when it's absent.
Rejections: the command's `x-rejections` in the contract, the same as slice.json's `SPEC_ERROR` titles.

## Step 2 — A form per submitted command

Where each field of the command comes from:

| The field | In the form |
|---|---|
| bound by a visible `data-field` input in the mockup | typed: a React Hook Form input, validated by Zod |
| bound by `<input type="hidden" data-field="…">` | a prop: the page gives it (its route, or the row of the list the form is drawn in) |
| `mapping: "session:<key>"` | **not sent:** the API takes it from the token (ADR-055 part 2); it isn't in the contract's body. The page is still behind `RequireSession` (it needs someone signed in), and may show `useSession()[key]` |
| `generated: true` | not sent: the backend makes it, and a 201 returns it |
| `mapping: "derived:<another system's browser library> …"` (e.g. `derived:Paddle.js checkout.completed data.transaction_id`) | what that library gave back, through the provider's module: see "A value from another system's browser library" below |

Every field that is sent goes in the body: `POST {apiEndpoint}` with the whole command, never an ID in the path
(ADR-025).

```tsx
type RegisterCourse = components["schemas"]["RegisterCourseBody"]

/** registerCourse's fields (slice.json), checked against the body the API contract documents. */
const RegisterCourseSchema = z.object({
    id: z.string().trim().min(1, "Required"),
    title: z.string().trim().min(1, "Required"),
    capacity: z.number({ error: "Required" }).int().min(1, "At least 1")
}) satisfies z.ZodType<RegisterCourse>
```

- One Zod entry per **typed** field: `String` → `z.string().trim().min(1, "Required")`, `Int`/`Long` →
  `z.number({ error: "Required" }).int()` with `register(name, { valueAsNumber: true })`, `Boolean` → a checkbox,
  `optional: true` → `.optional()`. Add the constraints the slice's specifications state (a rejection like
  "Rating must be between 1 and 5", a required text), so a 400 scenario is caught before anything is sent. `satisfies z.ZodType<Body>` when every body field is typed;
  when some come from props or the session, `satisfies z.ZodType<Pick<Body, "rating">>` over the typed ones.
- Each typed field is a `Field` (`id="{command}-{field}"`, the mockup's label, `error={errors.x?.message}`,
  `{...register(…)}`). A mockup `<select>` is `<Field control="select">` with its `<option>`s, with
  `register(name, { valueAsNumber: true })` for a number and `defaultValues` for the mockup's `selected` option. A
  mockup `<textarea>` is `<Field control="textarea">`, registered as a string; it starts empty (its text in the
  mockup is the example value, not a default). A mockup group of checkboxes or radios (a `fieldset`) is a
  `ChoiceGroup` with the mockup's legend and options.
- `useForm({ resolver: zodResolver(Schema) })`. A form with nothing typed (only props and session) is a plain
  `<form onSubmit>` with `useState` for done / error.
- **Every command is sent through `useSubmitOnce` (`@/lib/submit`, ADR-067), and its button is disabled while
  `pending`** (never RHF's `isSubmitting` or a `sending` state: they disable only at the next render, so a quick
  second press sends twice). The hook ignores a press while one is sending, and gives each press of the form one
  `Idempotency-Key` until the server answers:
  ```tsx
  const { run, pending } = useSubmitOnce()
  const submit = handleSubmit((body) =>
      run(async (key) => {
          const { position } = await command(api.POST("/register-course", { body, headers: idempotent(key) }))
          await recordWrite(position)      // useWrites(): refetches the views, remembers the position
          onDone?.(body)                   // the page's: it goes where the model says (next)
      }).catch((error) => setError("root", { message: errorText(error) }))
  )
  // <FormCard title="Register course" submit="Register course" onSubmit={submit} pending={pending}
  //           error={errors.root?.message} done={done && "Course registered."}> <Field … /> </FormCard>
  ```
  `FormCard` is the mockup's `form.mock-card`: its heading (`title`, or `label` when the mockup has none), the
  error at the top (focused), the button with the mockup's words (`submit`), "Sending…" while `pending`, and the
  `done` line (a success's words, from the mockup or the scenario). A form with nothing typed passes a plain
  handler (`(e) => { e.preventDefault(); run(…) }`) and keeps `done`/`error` in `useState`.
  **Every form takes `FormPart<Done>` (`@/lib/parts`):** `({ courseId, onDone }: { courseId: string } &
  FormPart<SubscribeStudent>)`, its ids then `onDone`, never a callback of its own name. Call `onDone({ ...body,
  ...data })` once the command succeeds: what was sent and a 201's generated fields (`command(...).data`), so the page
  can fill the next page's ids. The form's tests include one that presses twice before React renders
  (`fireEvent.click` twice) and expects one request, and one that `onDone` gets what was sent.
- A rejection is an `ApiError` carrying the backend's Problem-JSON `detail`. **The words shown are always
  `errorText(error)`** (`@/lib/api`): the rejection's own, or "Something went wrong. Try again.", never an
  exception's text. They go in `FormCard`'s `error` (RHF: `setError("root", { message })`). A field's error goes in
  its `Field`.
- **A command slice.json marks `confirm`** (the consequence a person accepts before something that can't be undone,
  ADR-072) asks first: `FormCard`'s `confirm={{ question, consequence, confirm }}`, or `RowAction`'s `confirm={{
  consequence, confirm }}`, with the consequence verbatim (a named constant) and `confirm` = the command's name in
  words ("Remove member"). A command without `confirm` never asks.
- **A form drawn in another slice's list rows** (Remove in each member row) is a `RowAction` alone: the mockup's
  button words as `action`, `onAct` sending the command through `run`, its `pending` and `error`. Its name includes
  the row (the `DataTable` it sits in gives it).

### A value from another system's browser library (ADR-044): a draft, on first use

> **Draft.** Proven by the module's own tests and Paddle's sandbox, not yet by a slice the loop built. Where a slice
> doesn't fit, block the job with `request-feedback` saying what didn't fit.

Some commands report what happened in **another system's part of the page**: the owner pays in Paddle's checkout, and
our page then reports that it completed. The command's field is mapped `derived:<the library> …`, and the slice's
description names the system. Read that system's provider skill (`provider-paddle`) first: it has the module, its
configuration and its mock.

- **The slice's component never imports the other system's library.** It calls the provider's module
  (`web/src/providers/{name}/`), which the first slice that needs it creates from the provider skill, with its tests.
- **The form's button starts the other system's part; the command is sent when that completes:**
  ```tsx
  // inside run(async (key) => { … }), like any command
  const outcome = await paddleCheckout().open({ items, customData: { organisationId }, frame: "checkout-frame", onSummary: setSummary })
  if (!outcome.completed) return                     // the buyer closed it: nothing sent, no error shown
  const { position } = await command(api.POST("/report-checkout-completed", { body: { organisationId, transactionId: outcome.transactionId }, headers: idempotent(key) }))
  await recordWrite(position)
  ```
  The mockup's `<form data-command="…">` is still the form: its button, its hidden fields as props.
- **A failure of the other system's part** (it couldn't open) is shown like a rejection: `errorText(error)` in
  `FormCard`'s `error`.
- **The other system's part goes where the mockup puts it:** an element with the class the provider skill names
  (`<div className="checkout-frame" />`), and beside it what the provider's module reports for showing (for Paddle,
  what will be charged).
- **Nothing the library reports is sent to our backend but the one value the command names:** no amounts, seats or
  status. Those come from our read models, after the other system's own events arrive.
- **Mock data:** the module's mock is one request (the provider skill gives its handler); it goes in the slice's
  `handlers.ts` with the others, answered with the command's example value.
- **Tests:** completed → the form sends exactly the example body; the module's request fails (`server.use(...)`
  answers it with a 500) → the alert shows and nothing is sent; not completed (the test replaces the module with
  `vi.mock`, since the mock always completes) → nothing is sent and no alert shows.

## Step 3 — A view per displayed read model

```tsx
const { afterLastWrite } = useWrites()
const course = useQuery({
    queryKey: ["course-details", courseId],
    queryFn: () => read(api.GET("/course-details/{courseId}", { params: { path: { courseId } }, headers: afterLastWrite() }))
})
return (
    <ViewCard title="Course" read={course}>
        {(c) => <SummaryList rows={[["Title", c.title], ["Capacity", <Value of={c.capacity} type="Int" />]]} />}
    </ViewCard>
)
```

- `ViewCard` is the mockup's `section.mock-card` and its heading; it shows loading, still updating and the alert
  itself, and the data once there. A view showing several cards uses `ReadStates` once, around them.
- A read model whose document is created by its first event (an aggregate, e.g. ratings) answers 404 until
  then. For such a view, give `empty` (the empty state, NN/g): what isn't there yet, in the mockup's words or the
  model's ("No ratings yet."), and, when the page gives `createPath`, the way to fill it (`action: { label, to:
  createPath }`). A list with no rows shows the same `empty` (`DataTable`'s, or `isEmpty`).
- Key facts (a mockup `<dl>`) are a `SummaryList`; every value by its field's type is a `Value` (`type` from
  slice.json: `Date`, `DateTime`, `Int`…, `Money` with its currency, `labels` for a coded value the mockup shows in
  words). An id is never shown as a fact unless the mockup shows it.

- **Read-your-writes, by `readModelType`:** absent or `database-projected` (async) → `headers: afterLastWrite()`.
  `inline-projected` and `live-report` are current when the command returns: **no headers**.
- The key (`/{courseId}`) is a prop: the page passes its route param or the session value, whichever
  `page.params` names.
- A query parameter the mockup has no input for is fixed at its slice.json example (`minRemainingSeats: 1` for
  "available courses"), as a named constant with a comment saying so.
- A `data-list` naming a **query** of the read model, or a list read model (`listElement`), is a **paged list**
  (ADR-026): `usePagedList` (`src/lib/paging.ts`) fetches a page at a time with `limit` and `cursor` beside the
  query's own parameters in `params.query`, `rows` are the pages so far, and `DataTable`'s `more={…}`
  puts Load more under them:
  ```tsx
  const courses = usePagedList({
      queryKey: ["course-seats", "available-courses", minRemainingSeats],
      fetchPage: ({ limit, cursor }) =>
          read(api.GET("/course-seats/available-courses", {
              params: { query: { minRemainingSeats, limit, cursor } },
              headers: afterLastWrite()          // async read models only, as for any view
          }))
  })
  // <ViewCard title="Courses" read={courses}>{() => <DataTable rows={courses.rows} … more={courses} />}</ViewCard>
  ```
  A `data-list` naming a `List` field comes whole with its document: `.map` over that field, no paging.
- **A list is a `DataTable`** (the mockup's `table[data-list]`): its `columns` are the mockup's, in order, each
  `{ header, cell }`; the first column names the row (a row header, so make it the thing's name, as the mockup's
  first cell).
- **Every list view takes `ViewPart<Row>` (`@/lib/parts`)** beside its ids, and hands it to the `DataTable`; it never
  knows page routes:
  - `row?: (row) => ReactNode`: another slice's action in each row (Withdraw): `DataTable`'s `actions`;
  - `linkTo?: (row) => string`: the row opens its page: `DataTable`'s `linkTo` (the first cell links);
  - `onlyOne?: (row) => void`: called (in an effect) when the list holds exactly one row;
  - `createPath?: string`: where the empty state's "New …" link goes: `empty.action.to`.
- `queryKey`: the read model's kebab name, then its key or query name and parameters.

## Step 4 — The mockup, through the patterns

The mockup gives the words and the order; the patterns give the markup. For each part this slice builds, take its
region of `mockup.html` and write it with the pattern each shape stands for:

| In the mockup (emcli's drafts draw these) | In the part |
|---|---|
| `form.mock-card`, its `h2` and button | `FormCard` (`title`, `submit` = the button's words) |
| a `label` and its `input` / `select` / `textarea` | `Field` (`control` for a select or textarea) |
| a `fieldset` of checkboxes or radios | `ChoiceGroup` (`legend`, `options`) |
| `section.mock-card` and its `h2`, showing a read model | `ViewCard` (`title`), or `ReadStates` around several cards |
| a `dl` of `dt`/`dd` | `SummaryList`, each value a `Value` |
| a `table[data-list]` | `DataTable` (`columns` in the mockup's order) |
| a command's button drawn in another slice's row | `RowAction` |
| an `h1`, a paragraph, static words ("places", "Signed in as") | as written, with `className` from the mockup |

- Keep the mockup's headings, labels, button text and static words exactly; drop every `data-*` attribute and the
  example values: a `data-field` element shows the data, a `data-list` repeats per row (`rowKey` = the row's id).
- Style only with the mockup's classes and the design system's tokens (`text-muted-foreground`): never
  `style={{ … }}` or a colour.
- Add nothing the patterns don't already: they hold loading, the alert, field errors, the success line, the empty
  state.

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
  any other key gets a 404 Problem-JSON whose `detail` is the contract's 404 description ("Course not found").
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
| a rejection (`then` `SPEC_ERROR`) | `server.use(...)` answers a 422 Problem-JSON whose `detail` is the `SPEC_ERROR` title **verbatim** (the backend sends exactly that; the status doesn't matter to the UI), and the alert shows it |
| a 400 for a typed field | fill the form without it (or with the invalid value): the field's message shows, and nothing is sent |
| one the screen can't produce (a 400 for a session or route value, or a range the `<select>` can't send) | no test; a comment naming the specification and why |

**No page tests.** The page is the kit's: `src/lib/model-page.test.tsx` covers how parts are put together, and
the journeys cover the pages for real. A part's own tests cover what it gives the page: a form's `onDone` gets `{
...body, ...data }`; a list view renders `row(r)` in each row when given, links rows with `linkTo`, and calls
`onlyOne` with one row and not with two. A view with several lists finds a list's rows `within` its own card, by its
heading, never with a view-wide `findByRole("listitem")`.

Every paged list also gets **"Load more adds the next page"**: `server.use(...)` answers the first request (no
`cursor`) with a row and a cursor, and the request with that cursor with another row and none; the test clicks
Load more, sees both rows, and sees the button gone.

## Step 7 — Export the parts

`web/src/slices/{slicename}/index.ts` exports this slice's parts, by the names `navigation.json` gives them on the
page (`emcli navigation` lists them): `{Command}Form` for a submitted command (`inviteMember` →
`InviteMemberForm`), `{ReadModel}View` for a displayed read model. A component named otherwise is exported under
that name.

```ts
// This slice's parts (ADR-069): the page puts them where navigation.json says.
export { InviteMemberForm } from "./InviteMemberForm"
export { CourseList as CourseListView } from "./CourseList"
```

That's all the page needs from you. **What the page does, never you** (`ModelPage`): puts the parts in the mockups'
order; shows a part only to who may use it (`useAllowed`) or read it (`useCanRead`); gives each part its ids (route,
session, row); puts a form drawn in another slice's list rows into that list's `row` slot; after `onDone`, goes to
`next` (on the registration page, to `?next=` first); on an entity's list page, gives a list its `linkTo`,
`createPath` and `onlyOne`; shows the page's heading.

- **This card's command is drawn inside another slice's list rows** (Withdraw in Pending invitations): build only
  the form, taking the row's ids as props, never a copy of the list. The page puts it in each row. If that list's
  view (another slice's) has no `row` prop yet, block with `request-feedback` asking for it (a few lines in that
  view): never edit another slice's folder.
- **A part the page shows differently from the mockup** (a heading, an order, a part only some people see): it's
  the model's, not yours. Block with `request-feedback` naming what the model should say.
- `src/lib/parts.test.ts` checks that every built slice exports the parts `navigation.json` names; it runs at commit.

## Step 8 — Verify, check, commit

1. **Against slice.json:** every field the forms send and the views show is in slice.json; every rejection test
   uses a `SPEC_ERROR` title verbatim; every `api.GET`/`api.POST` path is an `apiEndpoint` of this slice.
2. `cd web && npx tsc -b && npx vitest run src/slices/{slicename} src/lib/parts.test.ts`.
3. Commit the screen on its own (the backend is its own job, before or after this one):
   ```bash
   git add web/src/slices/{slicename} web/src/lib/api-types.ts   # and web/src/providers/{name}, if this slice made or changed it
   git commit -m "feat: [Slice Name] screen"
   ```
   The pre-commit guard runs `blocked-paths`, `web-scope` (only these paths, one slice, tests present, never a
   page or a kit component), `web-patterns` (the part is made of patterns, ADR-072), `api-types` (the types are what the contract generates) and `web-tests` (typecheck, the slice's tests and
   `parts.test.ts`).

## A screen added or changed (`buildScreen`)

The loop re-queues a slice it has built when its screen changed in the model: slice.json has `buildScreen`. The
backend is built and committed. Don't touch it; build only the screen.

- **`"added"`:** the slice had no mockup when it was built, so it has no `web/src/slices/{slicename}/` yet. Build it
  as new, Steps 1–8.
- **`"changed"`:** its mockup changed (a page's route, order or flow is the model's, and rebuilds nothing). Rebuild
  the slice's folder to match slice.json as it is now, Steps 1–8. Read what's there first, and keep what still
  matches:
  - markup, labels and fields follow the new mockup through the patterns (Step 4); drop what it no longer has. A
    part built before the patterns (ADR-072) is rewritten onto them as it's rebuilt;
  - the slice's own `*.test.tsx` are this skill's output, not a contract: update them to the new mockup, still a
    test per specification (the rule against editing tests is about the backend's `*.tests.ts`);
- Commit as in Step 8: `feat: [Slice Name] screen`.
