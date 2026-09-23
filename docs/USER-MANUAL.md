# Building an event-sourced app, one slice at a time

**A hands-on manual for emcli, prooph board, the DCB build kit and the Ralph loop**

This manual takes you from an empty directory to a working course-enrollment service. You design the system
as an **event model** on a visual board, and an AI build loop turns each piece of that model into tested code.
You don't need to know event sourcing to start. Each idea is explained the first time you need it.

The example grows the way real projects do. You don't know the whole model up front. You add a capability,
build it, use it, learn something, and add the next. Along the way you'll meet the most important technique in
this toolkit, **growing a read model as new events are discovered**, and see what the tooling does about the
data already in your database when you do.

> Every command in this manual was run, in this order, in a fresh project against a live board and database.
> The sample outputs are real. The loop built all 11 slices unattended, in 14.4 minutes, for $7.83 of Claude
> usage. Where a board screenshot belongs you'll see a generated diagram of the same board, drawn from the model.

---

## Contents

1. [The ideas in five minutes](#1-the-ideas-in-five-minutes)
2. [The tools and how they fit together](#2-the-tools-and-how-they-fit-together)
3. [Install](#3-install)
4. [Create the project](#4-create-the-project)
5. [Increment t0: register a course, see its details](#5-increment-t0-register-a-course-see-its-details)
6. [Increment t1: capacity changes (your first growing read model)](#6-increment-t1-capacity-changes-your-first-growing-read-model)
7. [Increment t2: students subscribe (a new field and a lookup)](#7-increment-t2-students-subscribe-a-new-field-and-a-lookup)
8. [Client feedback through the board](#8-client-feedback-through-the-board)
9. [Increments t3 and t4](#9-increments-t3-and-t4)
10. [Increments t5 and t6: a read model that's never stale](#10-increments-t5-and-t6-a-read-model-thats-never-stale)
11. [Increments t7–t10: switching read model types](#11-increments-t7t10-switching-read-model-types)
12. [Increments t11 and t12: querying read models](#12-increments-t11-and-t12-querying-read-models)
13. [Working with git: branches, commits and merges](#13-working-with-git-branches-commits-and-merges)
14. [How the Ralph loop builds a slice](#14-how-the-ralph-loop-builds-a-slice)
15. [Rebuilds in depth](#15-rebuilds-in-depth)
16. [Troubleshooting](#16-troubleshooting)
17. [Model by talking](#17-model-by-talking)
18. [Command reference](#18-command-reference)
19. [Known limits](#19-known-limits)

---

## 1. The ideas in five minutes

### Events: the system remembers what happened

A conventional app stores the *current state*: a `courses` table with a `capacity` column. When capacity
changes, the old value is overwritten and gone.

An **event-sourced** app stores *what happened*, as a list of facts in the order they occurred:

```
1  courseWasRegistered       { courseId: "c1", title: "Math", capacity: 30 }
2  courseCapacityWasChanged  { courseId: "c1", newCapacity: 45 }
3  studentWasSubscribed      { courseId: "c1", studentId: "s1" }
```

Each fact is an **event**. It's named in the past tense, because it has already happened and can't be undone.
The list is the **event store**, and it's append-only: events are never edited or deleted. Anything you want
to know (a course's current capacity, who is subscribed) can be worked out by reading the events.

### Commands: asking the system to do something

A **command** is a request: "register course c1", "change c1's capacity to 45". The system checks it against
the events it already has (*does c1 exist? is it already registered?*). If the command is allowed, the system
records one new event. If not, it rejects the command with an error, and nothing is recorded.

The code that makes this decision is a **decider**. It never reads a table. It reads the relevant events,
decides, and returns the new event.

### Read models: answering questions quickly

Replaying events on every question would be slow, so we keep **read models**: ready-made answers, updated as
events arrive. `CourseDetails` holds `{ courseId, title, capacity, subscribedStudents }` per course. The code
that keeps it up to date is a **projection**. It handles a list of event types (its `canHandle` list) and
updates the read model for each one.

A projection runs in the background and remembers how far it has read the event store. That position is its
**bookmark**. You'll see later why the bookmark matters a great deal.

That's the default kind of read model. The model can choose one of three per read model, with emcli's
`--read-model-type`:

| Type | Kept up to date | A reader straight after a write sees | Cost |
|---|---|---|---|
| `database-projected` (default) | in the background, by an **async** projection | possibly the old answer, for a moment | none on writes |
| `inline-projected` | in the same transaction as the events | always the new answer | every write of its events waits for it |
| `live-report` | not stored: worked out from the events on every read | always the new answer | every read replays that entity's events |

Most read models should stay async. §10 builds an inline one. A read model returns the same data whichever type
serves it, so you can switch later: §11 switches types and builds a live one. Besides the document for a key,
a read model can answer **queries** such as "the courses with free seats" (§12).

### Event modeling: designing on a timeline

**Event modeling** designs a system as a timeline you read left to right, with three kinds of sticky note:

| Sticky | Colour | Means |
|---|---|---|
| Command | blue | "someone asks for this" |
| Event | orange | "this happened" |
| Read model | green | "this is what someone can see" |

The timeline is cut into vertical **slices**. Each slice is one small feature you can build and ship on its own:

- a **state-change slice**: command → event (e.g. *register course*)
- a **state-view slice**: events → read model (e.g. *course details*)

Slices are the unit of work. The build loop builds one slice at a time.

### Growing a read model: copies and extension slices

This is the technique the toolkit is built around. Suppose `CourseDetails` exists, and later you discover a new
event, `courseCapacityWasChanged`, that should update it. On the timeline, the new event comes *after* the read
model, and arrows only point forward. So instead you place a **copy** of `CourseDetails` after the new event:
it's the same read model, drawn again at a later point in time. Each copy says "from here on, the read model
also reacts to *this*".

Each copy is its own slice, an **extension slice**. When the loop builds it, it doesn't create a new
projection. It extends the original one, adding only what the copy adds. So the original's code grows in
small, reviewed, tested steps, and the board shows every step.

### DCB: consistency by tags

The event store used here is **DCB** (Dynamic Consistency Boundary). Each event carries **tags** such as
`courseId=c1` or `studentId=s1`. A decider reads just the events with the tags it cares about. There are no
per-entity "streams" or "aggregates" to design up front. You'll see tags in the generated code; you don't
have to design them yourself.

---

## 2. The tools and how they fit together

| Tool | What it does | You use it to |
|---|---|---|
| **emcli** | A command-line editor for your event model. The model lives in a local `workspace.json` | create slices, stickies, fields, links and example scenarios |
| **prooph board** | A shared visual board (web) | show the model to your team or client; receive their notes |
| **DCB build kit** | Skills, checks and templates installed into your project | turn a slice into TypeScript code, tests and wiring |
| **Ralph loop** (`eventmodelers run`) | Runs in a terminal and builds every slice marked **planned**, one at a time, with Claude | build without writing the code by hand |
| **Postgres** (Docker) | Stores the events and the read models | run the app |

The cycle you'll repeat for every increment:

```
 model (emcli) ──► push (board) ──► commit ──► export ──► Ralph builds ──► progress to board ──► verify ──► merge
      ▲                                                                                                      │
      └──────────────────────────── feedback from the board (notes) ◄───────────────────────────────────────┘
```

---

## 3. Install

You need **Node.js 24**, **Docker** (running), **git**, **jq**, the **Claude Code** CLI (logged in), and a
**prooph board** account.

```bash
# 1. emcli: the model editor
git clone <emcli repo url> ~/Projects/emcli
cd ~/Projects/emcli && npm install && npm link          # puts `emcli` on your PATH

# 2. The eventmodelers CLI with the DCB build kit
git clone https://github.com/GaryACraine/Eventmodelers-Build-Kits.git ~/Projects/Eventmodelers-Build-Kits
cd ~/Projects/Eventmodelers-Build-Kits/eventmodelers-cli && npm install && npm link   # puts `eventmodelers` on your PATH

# 3. The DCB event store packages, next to your projects (the scaffold links them with `file:`)
git clone <dcb-event-store repo url> ~/Projects/dcb-event-store
cd ~/Projects/dcb-event-store && pnpm install && pnpm build
```

> **Why `npm link` and not `npx @eventmodelers/cli`?** `npx` downloads the *published* CLI, which doesn't yet
> contain the extension-slice features this manual relies on. `npm link` makes `eventmodelers` run your local
> copy.

Check:

```bash
emcli --help | head -3
eventmodelers --version
```

**prooph board:** create a workspace (or use an existing one) and an **API key** for it (*Settings → API*).
Note the key (`pb_…`) and the workspace ID.

---

## 4. Create the project

Projects must sit next to `dcb-event-store` (here, in `~/Projects`), because the scaffold refers to
`../dcb-event-store`.

```bash
mkdir ~/Projects/course-enrollment && cd ~/Projects/course-enrollment
git init -b main
eventmodelers init --stack dcb --hooks
```

When asked *"How do you want to configure credentials?"*, type **4** (*Skip for now*). This project talks to
prooph board through emcli, not to the eventmodelers platform.

The scaffold contains a complete worked example. We want to build our own from scratch, so reset it to an
empty context:

```bash
bash scripts/start-empty.sh
```

```text
Empty enrollment context ready: event-feed
```

Install dependencies. `--hooks` above installed the **pre-commit hook** (`.githooks/pre-commit`), which checks
every slice commit (see [§14](#14-how-the-ralph-loop-builds-a-slice)). Confirm it's on:

```bash
npm install
ls .githooks && git config core.hooksPath     # → pre-commit, and a path ending in .githooks
```

If `.githooks` is missing (the project was created without `--hooks`), run `eventmodelers init-hooks --stack dcb`.
Without it, commits aren't checked at all.

Create the model workspace and the environment file:

```bash
emcli workspace init "Course Enrollment"
cp .env.example .env
```

`init` also links emcli's Claude Code skills into `.claude/skills/`, one link per skill, next to the build kit's
own `build-*` skills. The one that matters here is **`event-model`**, which turns what you say into emcli commands
([§17](#17-model-by-talking)). The links point into your emcli checkout, so `init` git-ignores them. After a fresh
clone, run `emcli skills link` to recreate them.

Open `.env` and add your board credentials under the database settings that are already there:

```ini
PG_CONNECTION_STRING=postgresql://dcb:dcb@localhost:5432/dcb
PORT=3000
PROOPH_BOARD_API_KEY=pb_your_key_here
PROOPH_BOARD_WORKSPACE_ID=your-workspace-uuid
# optional: only if your board isn't on the default host
# PROOPH_BOARD_BASE_URL=https://flow.prooph-board.com/api
```

emcli ignores `workspace.json` in git by default, because it assumes the board is the source of truth. Here your
local model *is* the source of truth, so track it, and ignore the build loop's generated files instead:

```bash
sed -i.bak '/^workspace.json$/d' .gitignore && rm .gitignore.bak
printf '.build-kit/.slices/\nralph.log\n' >> .gitignore
```

Start the database and make the first commit:

```bash
docker compose up -d postgres
npm run build
git add -A && git commit -m "chore: empty DCB project with an emcli workspace"
```

### Names, not IDs

Every emcli command takes **names**: `emcli element add "register course" Enrollment command registerCourse`
means *in slice "register course", lane "Enrollment"*. Every element also has an ID, but IDs change the first
time you push to the board (the board replaces emcli's local IDs), so this manual never uses them.

Names match ignoring case, spaces and punctuation. A name that fits more than one thing is an error that lists
the candidates. That happens with **copies** (§6.2), which share their original's name. A bare name means the
original, and `"<slice>/<name>"` means the copy in that slice, e.g. `"course details capacity/CourseDetails"`.

emcli also remembers a **context**: `emcli use chapter "Course Enrollment"` lets later commands leave the chapter
out, and `emcli use slice …` / `emcli use spec …` do the same for scenarios. `emcli use` shows the current context.

### Three terminals

| Terminal | Runs |
|---|---|
| **1: model** | emcli commands, git (everything in this manual unless stated otherwise) |
| **2: loop** | `eventmodelers run --local 2>&1 \| tee ralph.log` (started once, left running) |
| **3: app** | the service, when you verify an increment |

---

## 5. Increment t0: register a course, see its details

**Goal:** a client can register a course, and anyone can read that course's details.

Each increment gets its own git branch. The loop builds on whatever branch is checked out, and you merge the
branch when the increment is done. **Creating, committing your model to, and merging this branch is your job.
The loop only adds its own code commits to it** (the full split is in
[§13](#13-working-with-git-branches-commits-and-merges)):

```bash
git switch -c increment/t0
```

(`git switch -c <name>` creates a branch from where you are and moves you onto it.)

### 5.1 Chapter and lanes

A **chapter** is one board page. **Lanes** are the horizontal rows: people at the top, commands and read
models in the middle, events at the bottom.

```bash
emcli chapter add "Course Enrollment" --context enrollment
emcli use chapter "Course Enrollment"
emcli lane add Student --type user-lane
emcli lane add Enrollment --type information-flow
emcli lane add "Enrollment Events" --type system
```

`--context enrollment` names the code's bounded context. Generated code lands in `src/contexts/enrollment/`.
`emcli use chapter` makes it the current chapter, so the commands below leave it out.

### 5.2 The *register course* slice (state change)

```bash
emcli slice add "register course"
emcli element add "register course" Enrollment command registerCourse
emcli element add "register course" "Enrollment Events" event courseWasRegistered
```

**Fields** are the data a sticky carries. The command and the event carry the same three:

```bash
for el in registerCourse courseWasRegistered; do
  emcli element field add "$el" courseId String --id --example c1
  emcli element field add "$el" title String --example Math
  emcli element field add "$el" capacity Int --example 30
done
```

`--id` marks `courseId` as the identity. The kit turns it into the event's tag (`courseId=c1`).

Link command → event (*"registerCourse produces courseWasRegistered"*), and give the command its HTTP route:

```bash
emcli dependency add registerCourse courseWasRegistered produces
emcli element update registerCourse --api-endpoint "/courses"
```

#### Scenarios: the slice's specification

A **scenario** (Given / When / Then) is an executable example: *given* these past events, *when* this command
arrives, *then* this event is recorded (or this error). The build loop turns each scenario into a test.

`emcli use slice` and `emcli use spec` point the next commands at a slice and a scenario. In
`spec step add <phase> <type> <name>`, `--link` links the step to the element with that name, and
`--seed-examples` fills the step's fields with the element's example values (`c1`, `Math`, `30`). Only a value
that differs needs setting, with `emcli spec step example <phase> <index> <field> <value>` (§6.1).

```bash
emcli use slice "register course"
emcli spec add "registers a new course"
emcli use spec "registers a new course"
emcli spec step add when command registerCourse --link --seed-examples
emcli spec step add then event courseWasRegistered --link --seed-examples

emcli spec add "rejects a course that is already registered"
emcli use spec "rejects a course that is already registered"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add when command registerCourse --link --seed-examples
emcli spec step add then error "Course already exists"
```

Check the scenarios read the way you intend:

```bash
emcli spec list "register course"
```

### 5.3 The *course details* slice (state view)

```bash
emcli slice add "course details"
emcli element add "course details" Enrollment information CourseDetails
emcli element field add CourseDetails courseId String --id --example c1
emcli element field add CourseDetails title String --example Math
emcli element field add CourseDetails capacity Int --example 30
emcli dependency add courseWasRegistered CourseDetails hydrates                       # the event feeds the read model
emcli element update CourseDetails --api-endpoint "/courses/{courseId}"

emcli use slice "course details"
emcli spec add "shows a registered course"
emcli use spec "shows a registered course"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add then readmodel CourseDetails --link --seed-examples
```

A state-view scenario says: *given* these events, *then* the read model shows this.

### 5.4 Plan, push, commit, export

Mark both slices **planned**. That's the signal for the loop to build them:

```bash
emcli slice status "register course" planned
emcli slice status "course details" planned
```

**Push to the board** so your team or client can see it:

```bash
emcli sync push --safe
```

```text
Pushing to board...
(--safe: deletions skipped)
  Create chapter: "Course Enrollment"
    Adopt default lane: "User Role" → "Student" [user-lane]
    Adopt default lane: "Information Flow" → "Enrollment" [information-flow]
    Adopt default lane: "System Context" → "Enrollment Events" [system]
    Remove default slice: "Slice 1"
    ...
    Create slice: "register course"
    Create slice: "course details"
    Create element: [command] "registerCourse"
    ...
Push complete. Baseline updated.
```

`--safe` never deletes anything on the board. prooph board gives every new chapter default lanes and slices;
emcli reuses the lanes and removes the empty slices.

![Board after the first push](images/diagram-t0-pushed.svg)

On the board, switch to the detailed view (the expand button next to the zoom controls, or Ctrl/Cmd+M). The
`CourseDetails` sticky now shows its fields and a **Dependencies** table listing the events that feed it.

![CourseDetails in the detailed view: fields and the Dependencies (CLI-managed) table](images/SS2.png)

Click the `register course` slice header and open **Details** to see its scenarios rendered as Given/When/Then.

![The register course slice details: the Specifications (CLI-managed) block](images/SS3.png)

The push replaced every local ID with the board's. The commands in this manual use names, so nothing changes for you.
**Commit before exporting.** The loop shares your working tree, and you don't want your model files swept
into its commits:

```bash
git add -A && git commit -m "model(t0): register course + course details"
```

**Export** the planned slices to the build loop:

```bash
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

```text
Exported 2 slice(s) to .build-kit/.slices
```

This writes one `slice.json` per slice into `.build-kit/.slices/enrollment/`. It holds everything the builder
needs: fields, events, scenarios, and for extension slices an `extends` block.

### 5.5 Let the loop build

In **terminal 2**, start the loop (once; leave it running for the rest of the manual):

```bash
cd ~/Projects/course-enrollment
eventmodelers run --local 2>&1 | tee ralph.log
```

```text
Ralph — kit: …/course-enrollment/.build-kit
         mode: local-only (no platform sync) — forced by --local
[ralph] onPlannedSlice: building slice "register course"...
→ Skill: build-state-change
→ Bash
…
done (117221ms, $0.9378)
[ralph] onPlannedSlice: building slice "course details"...
→ Skill: build-state-view
…
done (68798ms, $0.5815)
[ralph] No planned slices in current context "enrollment" — waiting.
```

For each slice the loop starts a fresh Claude agent. The agent reads `slice.json`, runs the matching skill,
builds, runs the slice's tests, runs the commit checks, and commits:

```bash
git log --oneline -4          # in terminal 1, once the loop says "waiting"
git status --short
```

```text
9349e17 chore: wire course details projection and route
e060da1 feat: course details
31eba83 chore: wire register course route
eeb59d5 feat: register course
?? .build-kit/AGENTS.md
?? progress.txt
```

Each slice gets a `feat:` commit (its own folder) and a `wire` commit (registering routes and projections in
`src/index.ts`, kept separate on purpose). `progress.txt` and `.build-kit/AGENTS.md` are the loop's memory:
what it built, and what it learned about this project. The loop sometimes commits them itself. Otherwise your
next `git add -A` picks them up.

> **Rule:** don't commit, pull or edit files while the loop is building. Wait for *"waiting"*.

### 5.6 Show progress on the board

The loop records each slice's status (InProgress / Done / Blocked) in `.build-kit/.slices`. Bring that back
into the model and push it:

```bash
emcli workspace import-status --build-kit .build-kit
emcli sync push --safe
git add -A && git commit -m "model(t0): built"
```

```text
  register course: planned → ready
  course details: planned → ready
```

![Board after t0 is built](images/diagram-t0-built.svg)
![Both t0 slices with status Ready on the board](images/SS4.png)

### 5.7 Verify it yourself

In **terminal 3**:

```bash
cd ~/Projects/course-enrollment
npm run build && node --env-file=.env dist/index.js
```

In **terminal 1**:

```bash
curl -s -X POST localhost:3000/courses -H 'content-type: application/json' -d '{"courseId":"c1","title":"Math","capacity":30}' -w '\n'
curl -s -X POST localhost:3000/courses -H 'content-type: application/json' -d '{"courseId":"c2","title":"History","capacity":20}' -w '\n'
curl -s -X POST localhost:3000/courses -H 'content-type: application/json' -d '{"courseId":"c1","title":"Math","capacity":30}' -w '\n'
curl -s localhost:3000/courses/c1 -w '\n'
```

```text
{"id":"c1"}
{"id":"c2"}
{"type":"about:blank","title":"Unprocessable Entity","status":422,"detail":"Course already exists","instance":"/courses"}
{"courseId":"c1","title":"Math","capacity":30}
```

The duplicate was rejected: the decider found `courseWasRegistered` for c1 among past events.
Stop the app (Ctrl-C in terminal 3). **Keep this data.** The next increments depend on it.

### 5.8 Merge the increment

```bash
git switch main && git merge --no-ff increment/t0 -m "Merge increment t0"
```

If your project has a remote, push the branch and open a pull request instead. The client can review the
board while the code is reviewed in the PR.

---

## 6. Increment t1: capacity changes (your first growing read model)

**Goal:** a course's capacity can change, and `CourseDetails` shows the new value.

This is where the model grows. There's a new command and event, *and* an existing read model has to react to
the new event.

```bash
git switch -c increment/t1
```

### 6.1 The *change course capacity* slice

```bash
emcli slice add "change course capacity"
emcli element add "change course capacity" Enrollment command changeCourseCapacity
emcli element add "change course capacity" "Enrollment Events" event courseCapacityWasChanged
for el in changeCourseCapacity courseCapacityWasChanged; do
  emcli element field add "$el" courseId String --id --example c1
  emcli element field add "$el" newCapacity Int --example 40
done
emcli dependency add changeCourseCapacity courseCapacityWasChanged produces
emcli element update changeCourseCapacity --api-endpoint "/courses/{courseId}/capacity"

emcli use slice "change course capacity"
emcli spec add "changes the capacity of a registered course"
emcli use spec "changes the capacity of a registered course"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add when command changeCourseCapacity --link --seed-examples
emcli spec step add then event courseCapacityWasChanged --link --seed-examples

emcli spec add "rejects a capacity change for an unknown course"
emcli use spec "rejects a capacity change for an unknown course"
emcli spec step add when command changeCourseCapacity --link --seed-examples
emcli spec step add then error "Course not found"
emcli spec step example when 0 courseId c9
```

The *given* in the first scenario uses `courseWasRegistered`, an event from a different slice. That's normal.
Deciders read whatever past events they need.

### 6.2 Copy the read model forward

`CourseDetails` must now also react to `courseCapacityWasChanged`. Don't draw an arrow back to the original
sticky. Place a **copy** after the new event, in a new slice:

```bash
emcli slice add "course details capacity"
emcli element copy CourseDetails \
  --slice "course details capacity" --lane Enrollment
emcli dependency add courseWasRegistered "course details capacity/CourseDetails" hydrates
emcli dependency add courseCapacityWasChanged "course details capacity/CourseDetails" hydrates
```

The copy inherits the original's fields and remembers its origin (`copyOf`). Wire **every** event that shapes
the read model so far, not just the new one. A copy shows the read model's complete inputs at that point in
time. emcli works out what's new by comparing with the previous copy.

```bash
emcli use slice "course details capacity"
emcli spec add "shows the changed capacity"
emcli use spec "shows the changed capacity"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add given event courseCapacityWasChanged --link --seed-examples
emcli spec step add then readmodel "course details capacity/CourseDetails" --link --seed-examples
emcli spec step example then 0 capacity 40
```

### 6.3 Stage it: ship the command first, keep the extension as a draft

Plan the new command now, but leave the extension as **draft**. The loop ignores drafts. This mirrors real
life: the capacity feature ships and gets used before the read model catches up. It's also exactly the
situation the automatic rebuild is designed for (§6.6).

```bash
emcli slice status "change course capacity" planned
emcli slice status "course details capacity" draft
emcli sync push --safe
git add -A && git commit -m "model(t1): change course capacity + CourseDetails copy (draft)"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

![Board with t1 staged](images/diagram-t1-staged.svg)
The loop picks up `change course capacity` by itself (it's still running in terminal 2). When it says
*waiting*, show progress and use the new feature:

```bash
emcli workspace import-status --build-kit .build-kit && emcli sync push --safe
git add -A && git commit -m "model(t1): capacity command built"
```

Terminal 3: `npm run build && node --env-file=.env dist/index.js`. Then in terminal 1:

```bash
curl -s -X PUT localhost:3000/courses/c1/capacity -H 'content-type: application/json' -d '{"newCapacity":45}' -w '%{http_code}\n'
curl -s -X POST localhost:3000/courses -H 'content-type: application/json' -d '{"courseId":"c3","title":"Physics","capacity":15}' -w '\n'
curl -s localhost:3000/courses/c1 -w '\n'
```

```text
204
{"id":"c3"}
{"courseId":"c1","title":"Math","capacity":30}
```

Capacity **still shows 30**. The change is recorded as an event, but no projection handles it yet. Stop the
app. Registering c3 afterwards matters for §6.6.

### 6.4 Plan the extension

```bash
emcli slice status "course details capacity" planned
emcli sync push --safe
git add -A && git commit -m "model(t1): plan course details capacity"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

See what the builder receives:

```bash
jq '.extends' ".build-kit/.slices/enrollment/coursedetailscapacity/slice.json"
```

```json
{
  "originElementId": "…",
  "originSliceId": "…",
  "originSliceTitle": "course details",
  "originContext": "enrollment",
  "previousInstanceId": "…",
  "addedEvents": ["courseCapacityWasChanged"],
  "addedFields": []
}
```

`extends` tells the builder: *this is not a new read model; add `courseCapacityWasChanged` to the `course details`
projection*.

### 6.5 What the loop does with an extension

The loop runs the same `build-state-view` skill, whose first step sees `extends` and switches to extension mode:

1. Opens the **origin's** read model definition (`readModel.ts`; `projection.ts` in projects built before
   §11's fold form) and checks the new event isn't handled already.
2. Appends it to `canHandle` and adds one `case` for it. It never edits existing code.
3. Gives any new field a default for older data (in `readModel.ts` the generic route then shows it; in the
   older `projection.ts` form the route maps it).
4. Appends a test block for the extension (`describe("course details capacity")`, or
   `describe.each(…)("course details capacity (%s)")` in `readModel.ts` form) to the origin's test file.
5. Commits. The pre-commit hook's **extension-additive** check rejects any edit or deletion of existing
   read model code, and **slice-tests** runs the whole test file, so every earlier scenario must still pass.

```bash
git show --stat HEAD~1          # after the loop says "waiting"
```

```text
feat: course details capacity
 .../enrollment/slices/coursedetails/projection.ts  |  9 +++++-
 .../enrollment/slices/coursedetails/route.tests.ts | 32 ++++++++++++++++++++++
```

There's no new folder. The original read model grew by one event. (Slice folders are named after the slice:
`coursedetails` or `course-details`, depending on the run. Both work.)

### 6.6 The automatic rebuild

Restart the app (terminal 3: `npm run build && node --env-file=.env dist/index.js`). The first log line is:

```text
Rebuilding CourseDetailsProjection: v1:courseWasRegistered → v1:courseCapacityWasChanged,courseWasRegistered
```

```bash
curl -s localhost:3000/courses/c1 -w '\n'
```

```text
{"courseId":"c1","title":"Math","capacity":45}
```

**45**: the change you made *before* the projection could handle it. Here's why that needed a rebuild. The
projection's bookmark had moved past that event when it processed c3's registration. A projection that simply
started handling a new event type would continue from its bookmark and never see the older capacity change.
On startup, `ensureProjectionsCurrent` compares each projection's list of handled events with the list it ran
with last time. When the list changes, it truncates the read model and replays every event from the start.
You don't do anything; §15 has the details.

Finish the increment:

```bash
emcli workspace import-status --build-kit .build-kit && emcli sync push --safe
git add -A && git commit -m "model(t1): built"
git switch main && git merge --no-ff increment/t1 -m "Merge increment t1"
```

---

## 7. Increment t2: students subscribe (a new field and a lookup)

**Goal:** students register and subscribe to courses, and `CourseDetails` lists each course's subscribers by name.

This extension adds a **new field** (`subscribedStudents`) and needs data from another entity (the student's
name comes from `studentWasRegistered`).

```bash
git switch -c increment/t2
```

### 7.1 Two new state-change slices

```bash
# register student
emcli slice add "register student"
emcli element add "register student" Enrollment command registerStudent
emcli element add "register student" "Enrollment Events" event studentWasRegistered
for el in registerStudent studentWasRegistered; do
  emcli element field add "$el" studentId String --id --example s1
  emcli element field add "$el" name String --example Ada
done
emcli dependency add registerStudent studentWasRegistered produces
emcli element update registerStudent --api-endpoint "/students"
emcli use slice "register student"
emcli spec add "registers a new student"
emcli use spec "registers a new student"
emcli spec step add when command registerStudent --link --seed-examples
emcli spec step add then event studentWasRegistered --link --seed-examples
emcli spec add "rejects a student that is already registered"
emcli use spec "rejects a student that is already registered"
emcli spec step add given event studentWasRegistered --link --seed-examples
emcli spec step add when command registerStudent --link --seed-examples
emcli spec step add then error "Student already exists"

# subscribe student
emcli slice add "subscribe student"
emcli element add "subscribe student" Enrollment command subscribeStudent
emcli element add "subscribe student" "Enrollment Events" event studentWasSubscribed
for el in subscribeStudent studentWasSubscribed; do
  emcli element field add "$el" courseId String --id --example c1
  emcli element field add "$el" studentId String --id --example s1
done
emcli dependency add subscribeStudent studentWasSubscribed produces
emcli element update subscribeStudent --api-endpoint "/courses/{courseId}/students"
emcli use slice "subscribe student"
emcli spec add "subscribes a registered student to a registered course"
emcli use spec "subscribes a registered student to a registered course"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add given event studentWasRegistered --link --seed-examples
emcli spec step add when command subscribeStudent --link --seed-examples
emcli spec step add then event studentWasSubscribed --link --seed-examples
emcli spec add "rejects a subscription to an unknown course"
emcli use spec "rejects a subscription to an unknown course"
emcli spec step add given event studentWasRegistered --link --seed-examples
emcli spec step add when command subscribeStudent --link --seed-examples
emcli spec step add then error "Course not found"
emcli spec step example when 0 courseId c9
emcli spec add "rejects a subscription for an unknown student"
emcli use spec "rejects a subscription for an unknown student"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add when command subscribeStudent --link --seed-examples
emcli spec step add then error "Student not found"
emcli spec step example when 0 studentId s9
```

### 7.2 The second copy: a new field with a nested shape

```bash
emcli slice add "course details subscriptions"
emcli element copy CourseDetails \
  --slice "course details subscriptions" --lane Enrollment
emcli element field add "course details subscriptions/CourseDetails" subscribedStudents Custom --cardinality List \
  --subfields "studentId:String,name:String" --example '[{"studentId":"s1","name":"Ada"}]'
for e in courseWasRegistered courseCapacityWasChanged studentWasRegistered studentWasSubscribed; do emcli dependency add "$e" "course details subscriptions/CourseDetails" hydrates; done
```

`Custom` + `--cardinality List` + `--subfields` describes a list of `{ studentId, name }` objects. All four
events are wired (cumulative). emcli will report `studentWasRegistered` and `studentWasSubscribed` as added,
measured against the *previous copy*, not the origin.

```bash
emcli use slice "course details subscriptions"
emcli spec add "lists a subscribed student by name"
emcli use spec "lists a subscribed student by name"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add given event studentWasRegistered --link --seed-examples
emcli spec step add given event studentWasSubscribed --link --seed-examples
emcli spec step add then readmodel "course details subscriptions/CourseDetails" --link --seed-examples

emcli spec add "a course with no subscriptions lists no students"
emcli use spec "a course with no subscriptions lists no students"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add then readmodel "course details subscriptions/CourseDetails" --link --seed-examples
emcli spec step example then 0 subscribedStudents '[]'
```

### 7.3 Ship the write slices first, then the extension

```bash
emcli slice status "register student" planned
emcli slice status "subscribe student" planned
emcli slice status "course details subscriptions" draft
emcli sync push --safe
git add -A && git commit -m "model(t2): students (planned) + CourseDetails copy (draft)"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

When the loop is *waiting*: `import-status` + `sync push` + commit (as in §5.6). Start the app and create
students and subscriptions. Then register a new course, which moves the projection's bookmark past them:

```bash
post() { curl -s -X POST "localhost:3000$1" -H 'content-type: application/json' -d "$2" -w ' %{http_code}\n'; }
post /students '{"studentId":"s1","name":"Ada"}'
post /students '{"studentId":"s2","name":"Grace"}'
post /courses/c1/students '{"studentId":"s1"}'
post /courses/c1/students '{"studentId":"s2"}'
post /courses/c2/students '{"studentId":"s2"}'
post /courses '{"courseId":"c4","title":"Chemistry","capacity":12}'
```

Stop the app, then plan the extension:

```bash
emcli slice status "course details subscriptions" planned
emcli sync push --safe
git add -A && git commit -m "model(t2): plan course details subscriptions"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
jq -c '.extends | {addedEvents, addedFields: [.addedFields[].name]}' .build-kit/.slices/enrollment/coursedetailssubscriptions/slice.json
```

```text
{"addedEvents":["studentWasRegistered","studentWasSubscribed"],"addedFields":["subscribedStudents"]}
```

The loop adds a private **lookup collection** of student names, fed by `studentWasRegistered`. On each
`studentWasSubscribed` it looks up the name and appends `{ studentId, name }` to the course. `subscribedStudents`
is optional in the document type, and the route returns `subscribedStudents ?? []`, so courses stored before
this step still answer correctly.

After the loop finishes, restart the app and check:

```bash
curl -s localhost:3000/courses/c1 -w '\n'
curl -s localhost:3000/courses/c3 -w '\n'
```

```text
{"courseId":"c1","title":"Math","capacity":45,"subscribedStudents":[{"name":"Ada","studentId":"s1"},{"name":"Grace","studentId":"s2"}]}
{"courseId":"c3","title":"Physics","capacity":15,"subscribedStudents":[]}
```

Every subscription made before the extension existed is there, because of the rebuild again. Finish:
`import-status`, `sync push`, commit, and merge `increment/t2` into `main`.

---

## 8. Client feedback through the board

The board is where your client sees the model. Their feedback comes back to you as **notes**.

1. On the board, the client writes a note in the details of the `course details subscriptions` slice. The
   sample note is: *"Client: we sometimes rename courses; this page must always show the current title."*
2. You pull:

```bash
emcli sync pull
jq -r --arg c "$CHAPTER" '.chapters[] | select(.name == $c) | .slices[] | select(.details | test("Client")) | "\(.label): \(.details)"' workspace.json
```

```text
course details subscriptions: "Client: we sometimes rename courses; this page must always show the current title."
```

(If the client wrote something else, search for their wording instead of `Client`.)

The pull changed `workspace.json`. You'll commit it at the start of the next increment (§9).

![A note in the course details subscriptions slice details, above the CLI-managed specifications](images/SS6.png)

On the board, the note sits at the top of the slice's documentation, above the CLI-managed block. In this screenshot
it reads *"my note"* instead of the sample text.

3. You respond by modeling the change, which is increment t4 in the next section.

What comes back on a pull, and what doesn't:

| Change made on the board | After `emcli sync pull` |
|---|---|
| Notes in a slice's or sticky's details | ✅ arrives in `workspace.json` |
| Renamed stickies or slices, new stickies | ✅ arrives |
| Edited field lists, dependencies, scenarios | ❌ your local model wins; they're re-rendered on the next push |
| A read model copied on the board | ⚠️ arrives as a new, unlinked sticky. The pull warns about it and prints the `emcli element update … --copy-of <origin>` command that marks it |

Your local model is the source of truth for structure. The board is where people see it and comment on it.

> **Important:** `sync pull` imports **every chapter** in the board workspace, including other people's. That's
> why every export in this manual uses `--chapter "Course Enrollment"`, and why the commands work inside the
> context chapter (`emcli use chapter`). Without `--chapter`, slices from other chapters could reach the build loop.

---

## 9. Increments t3 and t4

These repeat the t1/t2 pattern: a write slice, then a `CourseDetails` copy staged as draft, shipped after the
write slice.

**t3: students unsubscribe.** The slice is `unsubscribe student`: command `unsubscribeStudent`, event
`studentWasUnsubscribed { courseId, studentId }`, route `DELETE /courses/{courseId}/students/{studentId}`.
The error scenario is *"Student is not subscribed"*. Copy 3 goes in slice `course details unsubscriptions`,
wired to all five events so far, with the scenario *"an unsubscribed student is no longer listed"*. It adds no
field, so `addedEvents` is `["studentWasUnsubscribed"]` and `addedFields` is `[]`.

**t4: courses are renamed.** This is your answer to the client's note. The slice is `change course title`:
command `changeCourseTitle`, event `courseTitleWasChanged { courseId, newTitle }`, route
`PUT /courses/{courseId}/title`. The error scenario is *"Course not found"*. Copy 4 goes in slice
`course details title`, wired to all six events, with the scenario *"shows the new title"*.

The modeling commands for each are in two scripts in the kit repo:
[`docs/examples/t3.sh`](examples/t3.sh) and [`docs/examples/t4.sh`](examples/t4.sh). They use the same commands
and follow the same pattern as §6–§7. The git and loop steps around them are the same every time.

**t3**, from `main` in terminal 1:

```bash
git switch -c increment/t3
git add -A && git commit -m "model: pull client note"          # the §8 pull
bash ~/Projects/Eventmodelers-Build-Kits/docs/examples/t3.sh
emcli sync push --safe
git add -A && git commit -m "model(t3): unsubscribe student + CourseDetails copy (draft)"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

When the loop is *waiting* (it built `unsubscribe student`):

```bash
emcli workspace import-status --build-kit .build-kit && emcli sync push --safe
git add -A && git commit -m "model(t3): unsubscribe built"
```

Start the app (terminal 3). Grace leaves Math, then a new course is registered (moving the bookmark past the
unsubscribe):

```bash
curl -s -X DELETE localhost:3000/courses/c1/students/s2 -w '%{http_code}\n'
curl -s -X POST localhost:3000/courses -H 'content-type: application/json' -d '{"courseId":"c5","title":"Biology","capacity":18}' -w '\n'
```

Stop the app, then plan the extension:

```bash
emcli slice status "course details unsubscriptions" planned
emcli sync push --safe
git add -A && git commit -m "model(t3): plan course details unsubscriptions"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

When the loop is *waiting*, restart the app. It rebuilds, and Grace is gone from Math:

```bash
curl -s localhost:3000/courses/c1 -w '\n'
```

```text
{"courseId":"c1","title":"Math","capacity":45,"subscribedStudents":[{"name":"Ada","studentId":"s1"}]}
```

Finish, as always:

```bash
emcli workspace import-status --build-kit .build-kit && emcli sync push --safe
git add -A && git commit -m "model(t3): built"
git switch main && git merge --no-ff increment/t3 -m "Merge increment t3"
```

**t4** follows the same steps with `t4.sh`, branch `increment/t4`, and these app calls between shipping
`change course title` and planning `course details title`:

```bash
curl -s -X PUT localhost:3000/courses/c3/title -H 'content-type: application/json' -d '{"newTitle":"Quantum Physics"}' -w '%{http_code}\n'
curl -s -X POST localhost:3000/courses -H 'content-type: application/json' -d '{"courseId":"c6","title":"Art","capacity":10}' -w '\n'
```

After the extension is built and the app restarted, `curl -s localhost:3000/courses/c3 -w '\n'` shows
`"title":"Quantum Physics"`: the rename the client asked for, recorded before the read model could show it.

After t4 the model is complete:

![Final board](images/diagram-t4-final.svg)
![The final board: all 11 slices Ready, with the CourseDetails copies along the timeline](images/SS7.png)

`CourseDetails` now handles six events, added in four reviewed steps, and each step is visible on the board.

---

## 10. Increments t5 and t6: a read model that's never stale

The client has a new request: *"When a student takes the last seat, nobody else may see it as free, not even
for a moment."* Every read model so far is **async**: a projection follows the event store in the background,
so for a few milliseconds after a write, a reader can see the old answer. (An async read route lets a client wait
for its *own* write: it sends the `ETag` from its command's response as `If-None-Match`, with a `Prefer: wait=5` header. Other
readers don't know to wait.) Usually that's fine. Here it isn't.

An **inline** read model closes the gap. Its projection runs *inside* the append transaction, so the read model
changes in the same commit as the events. When the command returns, the read model is already current, for
every reader.

### 10.1 When to choose inline

Inline has a price. Every append of an event waits for each inline projection that handles it, while holding the
event store's consistency locks. One inline read model on `studentWasSubscribed` costs little. Ten would slow
every subscription. So:

- Choose inline only where a stale read is a business problem, not a cosmetic one. Here, a free seat that's
  already gone qualifies.
- Keep everything else async (the default).
- emcli's export warns when one event feeds three or more inline read models.

Also note: **a bug in an inline projection fails the command.** The projection runs in the append
transaction, so if it throws, the events are rolled back and the client gets an error. The build skill keeps
inline projection code small, with no external calls, and never throws for a missing document.

### 10.2 The *course seats* slice (t5)

`CourseSeats` answers "how many seats are free?" per course. It starts with registration and subscriptions.
Capacity changes come in t6, so you can watch an inline read model grow.

```bash
git switch -c increment/t5-course-seats

emcli slice add "course seats"
emcli element add "course seats" Enrollment information CourseSeats
emcli element field add CourseSeats courseId String --id --example c1
emcli element field add CourseSeats capacity Int --example 30
emcli element field add CourseSeats subscriptionCount Int --example 0
emcli element field add CourseSeats remainingSeats Int --example 30
for e in courseWasRegistered studentWasSubscribed studentWasUnsubscribed; do emcli dependency add "$e" CourseSeats hydrates; done
emcli element update CourseSeats --api-endpoint "/courses/{courseId}/seats" \
  --read-model-type inline-projected
```

`--read-model-type inline-projected` is the only new step. It goes on the origin. Every copy of it follows
automatically, and emcli rejects setting it on a copy.

The scenarios are written as before:
- *a registered course has all its seats free*: 30 capacity, 0 subscriptions, 30 free;
- *a subscription takes a seat*: 30, 1, 29;
- *an unsubscription frees the seat again*: 30, 0, 30.

For example:

```bash
emcli use slice "course seats"
emcli spec add "a subscription takes a seat"
emcli use spec "a subscription takes a seat"
emcli spec step add given event courseWasRegistered --link --seed-examples
emcli spec step add given event studentWasSubscribed --link --seed-examples
emcli spec step add then readmodel CourseSeats --link --seed-examples
emcli spec step example then 0 subscriptionCount 1; emcli spec step example then 0 remainingSeats 29
```

Then plan, push, commit and export, exactly as in §5.4. The exported `slice.json` carries
`"readModelType": "inline-projected"` on its read model.

### 10.3 What the loop builds differently

*(This walkthrough was recorded with the kit's earlier `projection.ts` form; with the current kit, the code is a
`readModel.ts` fold listed in `readModels`, as §11 shows, and nothing else changes for you.)*

The same `build-state-view` skill builds it, and its first step reads `readModelType`. The `projection.ts` is
written exactly like `CourseDetails`'s. The differences are all in how it's run:

| | async (`CourseDetails`) | inline (`CourseSeats`) |
|---|---|---|
| registered in `src/index.ts` | `projections` (consumer, bookmark, `waitFor`) | `inlineProjections`, passed to the `PostgresEventStore` |
| route | `preferWait` + bookmark ETag | plain GET: nothing to wait for |
| tests | read with `Prefer: wait` | read straight after the write, with no wait. That read is the proof |

```text
0d8275d feat: course seats
926c2af chore: wire course seats inline projection and route
```

The wiring commit is one line in `src/index.ts`:

```typescript
const inlineProjections: Projection[] = [courseSeatsProjection]
const eventStore = new PostgresEventStore({ pool, inlineProjections })
```

### 10.4 Verify: history, and reads that are never stale

Restart the app. The event store already holds t0–t4's history, but an inline projection only sees appends
made after it exists, so on its first start it is rebuilt from the whole history:

```text
Rebuilding CourseSeatsProjection: (new inline projection) → inline:v1:courseWasRegistered,studentWasSubscribed,studentWasUnsubscribed
enrollment listening on http://localhost:3000
```

```bash
curl -s localhost:3000/courses/c1/seats -w '\n'
curl -s localhost:3000/courses/c2/seats -w '\n'
```

```json
{"courseId":"c1","capacity":30,"subscriptionCount":1,"remainingSeats":29}
{"courseId":"c2","capacity":20,"subscriptionCount":1,"remainingSeats":19}
```

Ada and Grace subscribed to Math, and Grace unsubscribed, so one seat is taken. Math's capacity reads 30, not
45: `CourseSeats` doesn't handle capacity changes yet.

Now the difference that matters. Subscribe and unsubscribe 100 times, and read both read models the instant
each command returns, without `Prefer: wait`:

```bash
node --input-type=module -e '
const B = "http://localhost:3000"; let seats = 0, details = 0
for (let i = 0; i < 100; i++) {
  await fetch(`${B}/courses/c3/students`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentId: "s1" }) })
  const [s, d] = await Promise.all([fetch(`${B}/courses/c3/seats`).then(r => r.json()), fetch(`${B}/courses/c3`).then(r => r.json())])
  if (s.subscriptionCount !== 1) seats++
  if (!d.subscribedStudents.some(x => x.studentId === "s1")) details++
  await fetch(`${B}/courses/c3/students/s1`, { method: "DELETE" })
}
console.log(`stale reads: CourseSeats ${seats}, CourseDetails ${details}`)'
```

```text
stale reads: CourseSeats 0, CourseDetails 100
```

Your `CourseDetails` number will vary. On a fast local machine the async read model is behind almost every
time, because the read arrives before its consumer has caught up. `CourseSeats` is always 0.

Before closing t5, make one more change that `CourseSeats` can't see yet:

```bash
curl -s -X PUT localhost:3000/courses/c2/capacity -H 'content-type: application/json' -d '{"newCapacity":25}' -w '%{http_code}\n'
curl -s localhost:3000/courses/c2/seats -w '\n'      # still capacity 20
```

Import statuses, push, commit and merge the increment (§5.6, §5.8).

### 10.5 Grow it: capacity changes (t6)

An inline read model grows exactly like an async one, through a copy and an extension slice. The existing
`courseCapacityWasChanged` sticky sits earlier on the timeline, so an arrow from it to a *new* copy points
forward:

```bash
git switch -c increment/t6-seats-capacity
emcli slice add "course seats capacity"
emcli element copy CourseSeats --slice "course seats capacity" --lane Enrollment
for e in courseWasRegistered studentWasSubscribed studentWasUnsubscribed courseCapacityWasChanged; do emcli dependency add "$e" "course seats capacity/CourseSeats" hydrates; done
```

Add the scenario *a capacity change moves the free seats* (30 capacity, one subscription, capacity changed to
45: then 45, 1, 44), and plan, push, commit and export. The copy is inline because its origin is. The loop
treats it as an extension: it appends `courseCapacityWasChanged` to the origin's `canHandle` and a `case` that
recomputes `remainingSeats`, and it touches nothing else.

Restart the app:

```text
Rebuilding CourseSeatsProjection: inline:v1:courseWasRegistered,studentWasSubscribed,studentWasUnsubscribed → inline:v1:courseCapacityWasChanged,courseWasRegistered,studentWasSubscribed,studentWasUnsubscribed
```

```json
{"courseId":"c1","capacity":45,"subscriptionCount":1,"remainingSeats":44}
{"courseId":"c2","capacity":25,"subscriptionCount":1,"remainingSeats":24}
```

Both capacity changes are there: Math's from t1, and History's, made in t5 before the extension existed.

### 10.6 Async and inline, side by side

| | async | inline |
|---|---|---|
| a reader right after a write | may see the old answer unless it sends `Prefer: wait` | always sees the new one |
| cost | none on writes | every append of a handled event waits for it |
| a bug in the projection | the read model falls behind; the command still succeeds | the command fails and nothing is recorded |
| first start on existing history | its consumer reads from the beginning | rebuilt from the beginning (`Rebuilding …: (new inline projection)`) |
| growing it | copy → extension slice → automatic rebuild on restart | the same |

---

## 11. Increments t7–t10: switching read model types

A read model's type isn't fixed forever. Traffic grows, a client stops tolerating stale data, or you realise
you're storing data nobody needs to keep. Then you switch its type. The rule that makes this safe:

> **The data a client gets is the same whichever type serves a read model:** the same URL, the same response
> body and the same status (200, or 404 for an unknown key). Only freshness changes. Headers are not part of that
> promise: an async read model also sends an `ETag` and honours `Prefer: wait`, and the others don't.

This section switches `CourseDetails` from async to live, and `CourseSeats` from inline to live and on to async.
It also builds a new read model that is live from the start. Every body was compared before and after each
switch on the live database, and they were identical.

### 11.1 One definition, any type

The build kit writes each read model **once**, as a *keyed fold* in the slice's `readModel.ts`:
- `evolve(doc, event)` builds the document for one key (one course) from that key's events, in order;
- data from another entity, such as a student's name on a course, comes from a declared **lookup**.

```typescript
export const courseDetails = defineReadModel<CourseDetailsDoc, { students: StudentEntry }>({
    name: "CourseDetails",
    type: "database-projected",       // ← the only line a switch changes
    key: "courseId",
    collection: "course_details",
    canHandle: ["courseWasRegistered", "courseCapacityWasChanged", "studentWasSubscribed", …],
    lookups: {
        students: { key: "studentId", canHandle: ["studentWasRegistered"], evolve: (_, { event }) => ({ name: event.data.name }) }
    },
    evolve: (doc, { event }, { students }) => { … }
})
```

The scaffold's `src/shared/readModels.ts` runs that definition as any type:
- **Stored** (async or inline): a projection writes each document, and each lookup, to the database.
- **Live:** each GET folds the key's events straight from the event store. That takes two reads:
  1. The course's own events (tagged `courseId=c1`), whose tags name the students involved.
  2. One **union read**: the course's events *or* those students' `studentWasRegistered` events (tagged
     `studentId=…`), in the order they happened.

  That is the same sequence the stored projection processed, so the result is the same document.

The route is one generic call, `readModelRoute(courseDetails, …)`. Every slice serves its document the same way.
The tests run every scenario against all three types (`describe.each(READ_MODEL_TYPES)`), so every commit proves
the types agree.

> **Projects started before this kit version** have imperative `projection.ts` read models, like the outputs shown
> in §5–§10. Those can't switch type until they're converted to a `readModel.ts` fold, a one-off refactor. t7 below
> converts both of this project's read models.

### 11.2 Convert existing read models (t7)

Convert each read model by hand, in reviewed commits:
- **Slice commit:** add `readModel.ts` (with `version: 2`, so it's rebuilt from history through the new code),
  shrink `route.ts` to `readModelRoute`, and turn the existing scenarios into contract tests.
- **Wire commit:** list the read model in `src/index.ts`'s `readModels` array.
- **Cleanup commit:** delete `projection.ts`.

```text
Rebuilding CourseSeatsProjection: inline:v1:… → inline:v2:…
Rebuilding CourseDetailsProjection: v1:… → v2:…
```

Before and after, all 14 read-model URLs returned identical bodies and statuses. Those are
`/courses/{c1…c6, nope}` and `/courses/{…}/seats`, with key order ignored. The 10 existing scenarios now run as
30 contract tests.

### 11.3 Switch two read models to live (t8)

Set the new type on the **original** read model; its copies follow. Commit, then export:

```bash
git switch -c increment/t8-retype
emcli element update CourseDetails --read-model-type live-report
emcli element update CourseSeats --read-model-type live-report
git add -A && git commit -m "model(t8): retype CourseDetails and CourseSeats to live-report"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

```text
Exported 13 slice(s) to .build-kit/.slices (5 extension slice(s))
Re-queued 2 built read model(s) whose type changed:
  course details: database-projected → live-report
  course seats: inline-projected → live-report
```

Export puts both slices back to Planned with a `retype` block. That's the one case where it re-queues a Done
slice. The loop's change is one line each, and the **retype-scope** commit check allows nothing else:

```text
refactor: course details → live-report      readModel.ts | 2 +-     -    type: "database-projected",
refactor: course seats → live-report        readModel.ts | 2 +-     +    type: "live-report",
```

Restart the app. Every body is identical to before the switch. The stale-read test from §10.4 now finds
**0** stale reads for `CourseDetails` too, where it found 199 of 200 when it was async.

### 11.4 Switch back, and the rebuild (t9)

A stored read model that sat unused while live is out of date. To see it, switch `CourseSeats` to async, and
subscribe Ada to Chemistry (c4) first, while it's still live:

```text
live body:   {"courseId":"c4","capacity":12,"subscriptionCount":1,"remainingSeats":11}
stored doc:  {"courseId":"c4","capacity":12,"subscriptionCount":0,"remainingSeats":12,…}
```

After the loop's one-line retype, restart:

```text
Rebuilding CourseSeatsProjection: live:v2:… → v2:…
```

`/courses/c4/seats` now shows 1 subscription and 11 seats from storage, the same body as the live read gave.
While a read model is live, its fingerprint is recorded as `live:…` (§15), so switching back always rebuilds.

### 11.5 A new read model, live from the start (t10)

`StudentSubscriptions` lists a student's courses with their titles. The titles are a lookup: they come from
the courses' events.

```bash
git switch -c increment/t10-student-subscriptions
emcli slice add "student subscriptions"
emcli element add "student subscriptions" Enrollment information StudentSubscriptions
emcli element field add StudentSubscriptions studentId String --id --example s1
emcli element field add StudentSubscriptions name String --example Ada
emcli element field add StudentSubscriptions courses Custom --cardinality List \
  --subfields "courseId:String,title:String" --example '[{"courseId":"c1","title":"Math"}]'
for e in courseWasRegistered courseTitleWasChanged studentWasRegistered studentWasSubscribed studentWasUnsubscribed; do emcli dependency add "$e" StudentSubscriptions hydrates; done
emcli element update StudentSubscriptions --api-endpoint "/students/{studentId}/subscriptions" --read-model-type live-report
```

Add the scenarios as usual:
- *lists a subscribed course by title*;
- *an unsubscribed course is no longer listed*;
- *shows the title a course had when the student subscribed*.

Then plan, push, commit and export. From the event tags, the loop worked out that `studentWasRegistered`,
`studentWasSubscribed` and `studentWasUnsubscribed` build the document, and that `courseWasRegistered` +
`courseTitleWasChanged` are a `courses` lookup joined by the `courseId` tag.

```bash
curl -s localhost:3000/students/s1/subscriptions -w '\n'
```

```json
{"studentId":"s1","name":"Ada","courses":[{"courseId":"c1","title":"Math"},{"courseId":"c4","title":"Chemistry"}]}
```

### 11.6 When to choose live, and what it costs

A live read replays one entity's events, plus its lookups' events, on every GET. Measured on this project, with
300 sequential GETs each:

| Read | Events folded | Stored (median) | Live (median / p95) |
|---|---|---|---|
| `/courses/c1` (with the students lookup) | 5 + lookups | 2.1 ms | 4.2 / 5.1 ms |
| `/courses/c3` | 612 | 2.5 ms | 7.1 / 10.3 ms |
| `/courses/c1/seats` (no lookup) | 5 | 2.1 ms | 3.0 / 4.1 ms |
| `/courses/c3/seats` | 612 | 2.0 ms | 4.1 / 5.9 ms |
| `/students/s1/subscriptions` (courses lookup) | 813 | — | 9.4 / 12.9 ms |

- **Choose live** when a read model must never be stale, and each entity's history stays modest. Live costs
  nothing on writes (unlike inline) and stores nothing, so there's nothing to rebuild.
- **Choose inline** when it must never be stale but histories are long or reads are frequent.
- **Stay async** for everything else.

Live read models have two limits:
- **Keyed GETs, and tagged queries only.** A list would fold every entity on every request. emcli warns, and the
  loop asks you to choose another type. A query works live only if a tag narrows it to a few entities (§12.1).
- **Everything must be reachable by tags.** Every event must carry the read model's key as a tag, and every
  looked-up entity must be named by a tag on the events that reference it. If that fails, the loop explains
  which event breaks the rule.

---

## 12. Increments t11 and t12: querying read models

So far every read model answers one question: *the document for this key* (`/courses/c1`). Screens also ask
*which ones*: the courses that still have free seats, the courses a student takes. A **query** answers that. It
filters a read model's documents on their fields and returns a page of them.

A query doesn't store anything new. It reads the documents the read model already has, so adding one never
rebuilds anything. The rule from §11 still holds, per query:

> **A query returns the same page whichever type serves its read model.** The body is always
> `{ "data": [ …documents… ], "cursor"?: "…" }`, and the status is 200 even when nothing matches (never 404), or
> 400 for a bad parameter.

### 12.1 What a query is

You declare a query once, on the **original** read model; copies inherit it, as they inherit the type. It has:

- a **name** in camelCase, such as `availableCourses`;
- its own **GET route**, such as `/available-courses`. A `{param}` in the route is a path parameter;
- **named parameters.** Each has a type, an **operator** (`eq`, the default, or `ne gt gte lt lte in contains`)
  and the document **field** it compares (a dot path such as `subscribedStudents.studentId`). There's no
  general filter language, so the client contract stays small and stable;
- optionally a **sort** field. Without one, rows come in key order.

Every query also takes `limit` (default 50, at most 200) and `cursor`. When there are more rows, the response
carries a `cursor`. Pass it back to get the next page.

**Which types can serve it.** Stored read models (async and inline) serve every query. A **live** read model has
nothing stored to filter, so it serves a query only if a required `eq`, `in` or `contains` parameter names an
event **tag** (`--tag studentId`). The tag finds the few entities that could match, and only those are folded.
A query without a tag parameter is **stored-only**. On a live read model, export reports it, and the loop asks
you to add a tag or choose a stored type.

**Scenarios exercise a query.** In a read slice's scenario, *when* is one `query` step that names the query,
with example values for its parameters. *then* lists the documents it returns, in order: one `readmodel` step per
row, or none for "no matches". The loop builds the queries its slices' scenarios run. A query that no scenario
runs isn't built, because nothing would test it.

### 12.2 Model two queries (t11)

`availableCourses` lists the courses with at least a given number of free seats. `coursesForStudent` lists the
courses a student is subscribed to, sorted by title. It gets a tag, so it works live too: `CourseDetails` has been
live since §11.3.

```bash
git switch -c increment/t11-queries
emcli element query add CourseSeats availableCourses --endpoint /available-courses
emcli element query param add CourseSeats availableCourses minRemainingSeats Int \
  --operator gte --field remainingSeats --example 1
emcli element query add CourseDetails coursesForStudent \
  --endpoint '/students/{studentId}/courses' --sort title
emcli element query param add CourseDetails coursesForStudent studentId String \
  --operator contains --field subscribedStudents.studentId --tag studentId
```

```text
Added query "availableCourses" to "CourseSeats": GET /available-courses
Added parameter "minRemainingSeats" to query "availableCourses": remainingSeats gte
Added query "coursesForStudent" to "CourseDetails": GET /students/{studentId}/courses
Added parameter "studentId" to query "coursesForStudent": subscribedStudents.studentId contains, tag studentId
```

> **Pick a route that doesn't collide.** `/courses/available` would be swallowed by `/courses/{courseId}`, so
> emcli rejects it.

**Where the scenarios go.** `availableCourses` filters on `remainingSeats`, which the *course seats* slice
builds, so its scenarios go there. `coursesForStudent` filters on `subscribedStudents`, which only exists from
the *course details subscriptions* extension on (§7.2), so its scenarios go in that slice, on its copy.

```bash
emcli spec add "lists the courses with enough free seats"
emcli use spec "lists the courses with enough free seats"
emcli spec step add given event courseWasRegistered --link --seed-examples   # c1 Math 2
emcli spec step add given event courseWasRegistered --link --seed-examples   # c2 Art 1
emcli spec step add given event studentWasSubscribed --link --seed-examples   # s1 takes c2's only seat
emcli spec step add given event courseWasRegistered --link --seed-examples   # c3 Chess 3
emcli spec step add when query availableCourses --link CourseSeats --seed-examples
emcli spec step add then readmodel CourseSeats --link --seed-examples  # c1: capacity 2, 0 subscriptions, 2 remaining
emcli spec step add then readmodel CourseSeats --link --seed-examples  # c3: capacity 3, 0 subscriptions, 3 remaining
# … the example values, with ex, as in §5.2
```

```text
WHEN:
  [0] availableCourses (query): minRemainingSeats=`1`
THEN:
  [0] CourseSeats (readmodel): courseId=`c1`, capacity=`2`, subscriptionCount=`0`, remainingSeats=`2`
  [1] CourseSeats (readmodel): courseId=`c3`, capacity=`3`, subscriptionCount=`0`, remainingSeats=`3`
```

The four scenarios:
- *course seats*: "lists the courses with enough free seats" (above), and "no course has that many free seats"
  (`minRemainingSeats` 3, no rows).
- *course details subscriptions*: "lists a student's courses by title" (s1 takes Math and Art, s2 takes Chess:
  s1 gets Art, then Math), and "a student with no subscriptions has no courses".

Push, commit, export:

```bash
emcli sync push --safe
git add -A && git commit -m "model(t11): availableCourses on CourseSeats, coursesForStudent on CourseDetails"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
```

```text
Exported 14 slice(s) to .build-kit/.slices (5 extension slice(s))
Re-queued 2 built read slice(s) whose specs run new queries:
  course details subscriptions: add coursesForStudent
  course seats: add availableCourses
```

Both slices were Done. Export puts them back to Planned with `"addQueries": [ … ]` in `slice.json`. Only a
retype (§11.3) and added queries re-queue a Done slice.

### 12.3 What the loop builds

Start the loop. Each slice is one commit, and it only adds:

```text
feat: course details subscriptions query coursesForStudent   (80 s, $0.83)
  coursedetails/readModel.ts   | 9 +   ← into the origin's folder: this slice is an extension
  coursedetails/route.tests.ts | 37 +-
feat: course seats query availableCourses                    (68 s, $0.78)
  courseseats/readModel.ts     | 8 +
  courseseats/route.tests.ts   | 54 +-
```

The query is a few declarative lines in the read model's definition. The runtime turns them into SQL for
stored types or an in-memory filter for live ones, and mounts the route:

```typescript
    queries: {
        coursesForStudent: {
            path: "/students/:studentId/courses",
            params: {
                studentId: { field: "subscribedStudents.studentId", op: "contains", type: "string", tag: "studentId" }
            },
            sort: { field: "title" }
        }
    },
```

Each scenario becomes a test in a `describe.each(queryTypes(courseDetails, "coursesForStudent"))` block, which
runs it on every type that can serve the query: all three for `coursesForStudent`, and only the two stored types
for `availableCourses`. The only existing line that changes is the tests' import, which gains `queryTypes`. The
**query-additive** commit check (§14) holds the loop to that. For an extension, **extension-additive** does.

### 12.4 Verify it yourself

Restart the app. `CourseSeats` is async and `CourseDetails` is live, so these two answers come from storage and
from the event store respectively:

```bash
curl -s 'localhost:3000/available-courses?minRemainingSeats=1' -w '\n'
curl -s localhost:3000/students/s1/courses -w '\n'
```

```json
{"data":[{"capacity":45,"courseId":"c1","remainingSeats":44,"subscriptionCount":1},{"capacity":25,"courseId":"c2","remainingSeats":24,"subscriptionCount":1},{"capacity":15,"courseId":"c3","remainingSeats":14,"subscriptionCount":1},{"capacity":12,"courseId":"c4","remainingSeats":11,"subscriptionCount":1},{"capacity":18,"courseId":"c5","remainingSeats":18,"subscriptionCount":0},{"capacity":10,"courseId":"c6","remainingSeats":10,"subscriptionCount":0}]}
{"data":[{"courseId":"c4","title":"Chemistry","capacity":12,"subscribedStudents":[{"studentId":"s1","name":"Ada"}]},{"courseId":"c1","title":"Math","capacity":45,"subscribedStudents":[{"studentId":"s1","name":"Ada"}]}]}
```

Paging, and a bad parameter:

```bash
curl -s 'localhost:3000/available-courses?minRemainingSeats=1&limit=2' -w '\n'
curl -s 'localhost:3000/available-courses?minRemainingSeats=1&limit=2&cursor=WzAsMCwiIiwiYzIiXQ' -w '\n'
curl -s 'localhost:3000/available-courses?minRemainingSeats=abc' -w ' %{http_code}\n'
```

```text
{"data":[{…"courseId":"c1"…},{…"courseId":"c2"…}],"cursor":"WzAsMCwiIiwiYzIiXQ"}
{"data":[{…"courseId":"c3"…},{…"courseId":"c4"…}],"cursor":"WzAsMCwiIiwiYzQiXQ"}
{"status":400,"title":"Bad Request","detail":"Parameter \"minRemainingSeats\" must be a number"} 400
```

### 12.5 Indexes, and what queries cost (t12)

At startup the runtime creates the indexes a stored read model's queries need: one per compared field, a GIN
index for `contains`, one per sort order, and a key-order index for an unsorted query. You don't write any of
them. Measured with 20,000 courses, 20,000 students and 100,000 subscriptions (140,000 events), with 300 calls each,
page limit 50:

| Query | With the indexes (median) | Without |
|---|---|---|
| `coursesForStudent` (stored, 5 rows) | 0.40 ms | 8.84 ms |
| `availableCourses` ≥500 (200 of 20,000 match) | 0.50 ms | 6.58 ms |
| `availableCourses` ≥1 (96% match), first page | 0.50 ms | 7.82 ms |
| `availableCourses` ≥1, a page deep in the results | 0.40 ms | 3.47 ms |
| `coursesForStudent` (**live**) | 14.1 ms | — |

- **Stored queries stay flat** as the table grows, because every page is an index lookup. Without the indexes,
  each page scans the whole table.
- **The last two stored rows are t12.** An unsorted query returns rows in key order. At first that order had no
  index, so a query most courses match sorted all 19,200 matches to return 50. t12 was only a kit update: the
  key-order index and a cursor that uses it. Nothing in the model or the slices changed.
- **Live queries don't grow with the table.** The tag narrows the work to one student's five courses, but each of
  those is a fold: 22 event-store reads per request, so it's about 35 times the stored cost. It returned the same
  pages as the stored copy in all 50 comparisons.

> **After a rebuild, run `VACUUM ANALYZE`.** A rebuild (§15) rewrites every document. Until autovacuum catches
> up, the leftover dead rows, and a GIN index's backlog of pending entries, can make Postgres skip an index. On
> 2,000 courses right after the load, `coursesForStudent` took 1.26 ms instead of 0.36 ms, until
> `VACUUM ANALYZE course_details`.

**Choosing:**
- **Use a query** for "which ones" questions a client asks often. Declare parameters for what the screen
  filters on, not a general search.
- **Keep read models that serve heavy queries stored.** Live can serve a tagged query, and the answer is never
  stale, but each request costs the folds of every candidate.
- **Out of scope:** OR conditions, full-text search, counts and sums, and joins across read models. Model a read
  model that holds the answer instead.

---

## 13. Working with git: branches, commits and merges

Two parties commit to your repository: **you** (the model, and your bookkeeping) and **the loop** (the code).
They share one working tree, so the order of operations matters. This section brings together the git steps
used throughout the manual.

### You vs the loop, at a glance

| Git action | **You** | **The loop** |
|---|---|---|
| Create the increment branch (`git switch -c increment/tN`) | ✅ always | ❌ never |
| Switch branches | ✅ only while the loop is idle | ❌ never, it stays where you put it |
| Commit the model (`workspace.json`) | ✅ `model(tN): …` commits | ❌ |
| Commit code, tests, wiring | ❌ | ✅ `feat: …` and `chore: wire …` commits |
| Commit the loop's notes (`progress.txt`, `.build-kit/AGENTS.md`) | ✅ if the loop left them uncommitted (your next `git add -A`) | ✅ sometimes (`chore: progress …`) |
| Run the commit checks | automatic (the hook), for any commit touching a slice folder | ✅ before every `feat:` commit, and the hook runs them again |
| Merge the increment into `main` / open a PR | ✅ | ❌ never |
| Push to a remote | ✅ | ❌ never |

**Your git checklist for every increment:**

1. `git switch main && git switch -c increment/tN`, before modeling.
2. Model → `emcli sync push --safe` → **`git add -A && git commit -m "model(tN): …"`** → export.
3. Hands off while the loop builds: no commits, pulls, edits or branch switches.
4. When the loop says *waiting*: `import-status` + `sync push` → **`git add -A && git commit -m "model(tN): built"`**.
5. Verify, then **merge**: `git switch main && git merge --no-ff increment/tN` (or push and open a PR).

Everything else in the history (every `feat:` and `chore:` commit) is the loop's.

### One branch per increment

Every increment of the model gets its own branch, created from an up-to-date `main`:

```bash
git switch main
git switch -c increment/t2            # create the branch and move onto it
```

The loop **never creates, switches or merges branches**. It builds on whatever branch is checked out when it
picks up a slice. So the branch you create is where all of the increment's work lands: your model commits and
the loop's code commits.

Why one branch per increment (and not one per slice)? An extension slice edits code that an earlier slice
created. If each slice had its own branch, the extension's branch wouldn't contain the code it extends.
Branching per increment keeps everything an increment needs in one place, and gives you one reviewable
unit: the model change the client saw on the board, together with the code that implements it.

### Who commits what

This is the real history of `increment/t1` from this manual's own run, oldest first:

```text
a029ed6  you    model(t1): change course capacity + CourseDetails copy (draft)   ← model + staging
83660b4  loop   feat: change course capacity                                     ← slice code + tests
385ec07  loop   chore: wire change course capacity route                          ← src/index.ts wiring
6e39774  you    model(t1): capacity command built                                 ← statuses back from the loop
9c32fe4  you    model(t1): plan course details capacity                           ← draft → planned
d7ca76c  loop   feat: course details capacity                                     ← the extension
02065e7  you    model(t1): built                                                  ← final statuses
```

| Commit | Made by | Contains | Checked by the hook? |
|---|---|---|---|
| `model(tN): …` | you | `workspace.json`, and the loop's notes (`progress.txt`, `.build-kit/AGENTS.md`) | no (touches no slice folder) |
| `feat: <slice>` | loop | the slice's folder: code and tests. For an extension, the origin's folder | **yes**: all eight checks, including the slice's tests |
| `chore: wire <slice> …` | loop | `src/index.ts` only (registering the route and projection) | no (kept separate on purpose; `blocked-paths` forbids it in a slice commit) |
| `chore: progress + learnings …` | loop, sometimes | `progress.txt`, `.build-kit/AGENTS.md` | no |

The loop doesn't always commit its notes. If `git status` shows `progress.txt` or `.build-kit/AGENTS.md`
modified, your next `model(tN): …` commit picks them up (`git add -A`).

### When you commit

1. **After modeling and pushing, before exporting.** The push rewrites IDs in `workspace.json`, so commit after
   it. Commit *before* `workspace export` hands work to the loop. Once the loop starts, anything uncommitted in
   the working tree could be swept into its commit, and the hook would reject a slice commit that contains
   `workspace.json`.
2. **Never while the loop is building.** Wait until `ralph.log` says *waiting* (or the slice is `Done` and the
   last commit has landed). That includes `sync pull`, editing files, and switching branches.
3. **After `import-status` + `sync push`**, to record the statuses the loop reported.

The usual rhythm within an increment:

```bash
# model with emcli …
emcli sync push --safe
git add -A && git commit -m "model(tN): <what you modeled>"
emcli workspace export --build-kit .build-kit --chapter "Course Enrollment"
# … the loop builds and commits; wait for "waiting" …
emcli workspace import-status --build-kit .build-kit && emcli sync push --safe
git add -A && git commit -m "model(tN): built"
```

### Merging an increment

When every slice of the increment is `ready` and you've verified the app, merge the branch into `main`.

**Locally:**

```bash
git switch main
git merge --no-ff increment/t1 -m "Merge increment t1"
```

`--no-ff` always creates a merge commit, so `main` shows each increment as one unit:

```text
*   4d5e56a Merge increment t1
|\
| * 02065e7 model(t1): built
| * d7ca76c feat: course details capacity
| * …
|/
*   5b1514f Merge increment t0
```

**With a remote (GitHub)**, push the branch and open a pull request instead. That's a natural point for the
client to review the board while the team reviews the code:

```bash
git push -u origin increment/t1
gh pr create --base main --head increment/t1 --title "Increment t1: capacity changes" \
  --body "Model: change course capacity + CourseDetails extension. All slices ready; verified on a live DB."
gh pr merge --merge                   # after review
git switch main && git pull
```

Then start the next increment from the updated `main`: `git switch -c increment/t2`.

### If something goes wrong

| Situation | What to do |
|---|---|
| The loop committed on the wrong branch | Stop the loop. `git switch <right branch> && git merge --ff-only <wrong branch>` (or cherry-pick), then restart the loop |
| You forgot to create the increment branch | `git switch -c increment/tN` now. The commits already made on `main` move along with the new branch; reset `main` afterwards if needed: `git branch -f main origin/main` or to the last merge commit |
| A commit was rejected by the hook | Nothing was committed. Read the message, fix, commit again. Never use `--no-verify` |
| An interrupted slice left uncommitted files | The loop stashes them itself and rebuilds the slice. Look for `ralph: interrupted slice …` in `git stash list`, and drop it once the rebuilt slice is committed |

---

## 14. How the Ralph loop builds a slice

For every slice with status **Planned** in `.build-kit/.slices/<context>/index.json`, the loop starts a fresh
Claude agent with the kit's build prompt. The agent:

1. Sets the slice to **InProgress**.
2. Reads `slice.json` and picks the skill: `build-state-change`, `build-state-view` (including extension mode)
   or `build-automation`.
3. Writes the code, tests and events using only what `slice.json` contains. It never invents fields.
4. Runs `npm run build` and the slice's tests.
5. Stages and runs `npm run run:checks -- --staged`, then commits `feat: <slice>`, with the `src/index.ts`
   wiring as a separate commit.
6. Sets the slice to **Done**, and appends to `progress.txt` and `.build-kit/AGENTS.md`.

**If the agent is interrupted** (Claude usage ran out, a crash, the terminal closed), the slice is left
InProgress. With `--local`, the loop cleans up after its own agent: when the agent's run ends, or when the loop
next starts if the loop itself was killed, it stashes the files the run created or changed as
`ralph: interrupted slice "<slice>"`, sets the slice back to **Planned**, and builds it again from scratch. Files
you had already changed before the run started stay in place. If the agent had already committed part of the
slice, the loop marks it **Blocked** instead, because a rebuild would collide with those commits. Each recovery
is noted in `progress.txt`.

**The pre-commit hook** (installed by `init --hooks`) runs the same checks on every commit that touches a slice
folder, so nothing can skip them:

| Check | Rejects |
|---|---|
| blocked-paths | slice commits that touch `package.json` or `src/index.ts` |
| slice-scope | changes outside the slice's own folder |
| extension-additive | an extension that edits or removes existing projection code, or lacks its test block |
| query-additive | adding queries that changes anything but the `queries` block and new query tests |
| retype-scope | a retype that changes more than the `type:` line |
| test-file-present | code without a test file |
| no-invented-fields | fields not in `slice.json` (heuristic) |
| spec-coverage | fewer tests than scenarios |
| tsc-build | TypeScript errors |
| slice-tests | failing tests in any slice folder the commit touches |

If a check fails, the agent must fix the code, or set the slice to **Blocked** with the reason. It never
commits over a failure.

**Branches:** the loop never creates, switches or merges branches. It builds on whatever is checked out. That's
why each increment starts with `git switch -c increment/<name>` (see [§13](#13-working-with-git-branches-commits-and-merges)).

**Statuses:** only `planned` slices are built. `draft` (exported as `Created`) is ignored, which lets you stage
work. Once the loop has marked a slice InProgress, Done or Blocked, re-exporting keeps that status.

---

## 15. Rebuilds in depth

A projection reads only the event types in its `canHandle` list, and only from its bookmark onward. The bookmark
moves forward with every event the projection handles. So when an extension adds an event type, any events of
that type recorded *before* the upgrade are behind the bookmark, if anything the projection already handled came
after them. The upgraded projection would skip them.

`src/shared/ensureProjectionsCurrent.ts` runs at startup, before the projections start. For each projection it
stores a **fingerprint**:

```text
v<version>:<sorted canHandle list>        e.g.  v1:courseCapacityWasChanged,courseWasRegistered
```

- **First start:** the fingerprint is recorded. The projection reads from the beginning anyway.
- **Fingerprint changed:** the projection is rebuilt: its collections are emptied and every event is replayed.
  You'll see `Rebuilding <Projection>: <old> → <new>` in the log.
- **Unchanged:** nothing happens.

**When to bump `version`:** if an extension derives a *new field from an event the projection already handles*,
`canHandle` doesn't change, so bump `version` in `projection.ts` to force the rebuild. The skill does this
automatically when needed.

**Inline projections** (§10) have no consumer and no bookmark to catch up from. They only see events appended
after they exist. So for them:

- **First start:** the projection is rebuilt from the whole history, not just recorded:
  `Rebuilding <Projection>: (new inline projection) → inline:v1:…`.
- **Fingerprint changed:** rebuilt, exactly as above. Their fingerprint starts with `inline:`, so switching a
  read model between async and inline also rebuilds it.

The rebuild runs at startup, before the app takes requests, so no command can append while it runs.

**Live read models** (§11) store nothing, so they never rebuild. Their fingerprint is recorded as `live:…`,
so switching one back to a stored type always rebuilds its stored copy, which went stale while unused.

**Cost:** a rebuild replays all the events this projection handles, so startup waits for it. That's
instantaneous in this example, and it grows with your event store.

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No slice matches "…"` / `No element matches "…"` | a typo, or the wrong context chapter | `emcli use` shows the context; `emcli slice list`, `emcli element list` show the names |
| `"…" matches 2 elements` | a copy shares its original's name | name the copy as `"<slice>/<name>"` (§4, *Names, not IDs*) |
| `Chapter not found: <id>` from an old script | IDs changed on the first push | use names instead of IDs |
| `400 Only one information-flow lane is allowed per chapter` on the first push | an old emcli without new-chapter support | update emcli (`git pull` in the emcli repo) |
| `sync diff` prints "No sync baseline found" | nothing has been pushed yet | push once. The first push has no preview |
| the loop builds nothing | no `planned` slices in the current context, or the export was skipped | set status `planned`, `sync push`, commit, then `workspace export --build-kit … --chapter …` |
| a slice stays `Created` | it's `draft` in the model | `emcli slice status … planned`, then re-export |
| a Done slice doesn't rebuild after re-planning | loop-owned statuses win on export | model the change as a new copy/extension slice |
| a slice goes **Blocked** | a check failed and the agent couldn't fix it | read the reason in `.build-kit/.slices/<ctx>/index.json`, fix the model or code, set it back to `planned` |
| commit rejected: `[slice-tests]` | a test fails | fix it. The message names the failing scenario |
| commit rejected: `[extension-additive]` | an extension changed existing projection code | keep extensions to additions only |
| a read model is missing older data after an extension | the app wasn't restarted, so no rebuild | restart the app and look for `Rebuilding …` |
| a command that used to work returns 500 after an inline read model was added | the inline projection threw, so the whole append rolled back (§10.1) | read the app log for the projection's error and fix it in its `projection.ts`. Nothing was recorded, so the client can retry |
| a live slice goes **Blocked** naming an event, a list or a query | a live read model needs every event tagged with its key, lookups reachable by tags, a keyed GET, and a tag parameter on each query (§11.6, §12.1) | tag the event in the model, or choose `inline-projected` / `database-projected` for it |
| a retype goes **Blocked**: "imperative projection … a refactor" | the read model is an older `projection.ts` | convert it to `readModel.ts` first (§11.2), then export again |
| export didn't re-queue a type change | the type was changed on a copy, or the slice isn't built yet | change it on the original read model. An unbuilt slice is just built with the new type |
| slices from other chapters appear in `.build-kit/.slices` | exported without `--chapter` after a `sync pull` | re-export with `--chapter "Course Enrollment"` |
| `eventmodelers init` crashes with `ERR_USE_AFTER_CLOSE` | no terminal input was available | run it in an interactive terminal and answer the prompts |
| a slice went back to Planned and `git stash list` shows `ralph: interrupted slice …` | the agent was interrupted mid-slice (Claude usage ran out, a crash, the terminal closed). The loop stashed the partial work and rebuilds the slice (§14). If Claude is still unavailable, the loop retries every 60 s | nothing, once Claude is available again (restart the loop if you closed it). Drop the stash after the rebuilt slice is committed: `git stash drop stash@{N}` |
| a slice is **Blocked** after an interruption | the agent committed part of the slice but was interrupted before marking it Done. `progress.txt` names the commits | check them with `git log`. If the slice is complete, set it to Done. Otherwise `git revert` them and set it back to Planned |
| a slice stays **InProgress** and the loop says *waiting* | an interrupted agent, with the loop running with board sync (without `--local`). There the loop can't tell an interrupted claim from another agent's, so it only logs a warning | once no agent is building it: `git stash push -u -m "interrupted slice"`, then set the slice back to Planned on the board |

---

## 17. Model by talking

Everything in §5–§12 can be said instead of typed. emcli's **`event-model`** skill (linked into `.claude/skills/` by
`emcli workspace init`, §4) turns what you tell Claude Code into the same emcli commands, pushes the result to the
board so you can watch the model grow, and hands planned slices to the loop.

### Set up a project for a new process

To model a process of your own (not course enrollment), start a new project. It isn't just a folder: `eventmodelers
init` creates the whole DCB project (a Node project, the build kit, the loop's skills), so there's no `npm init`.
The steps are §4's, with a new name and three differences. The example uses *library lending*; use your own.

```bash
mkdir ~/Projects/library-lending && cd ~/Projects/library-lending   # next to dcb-event-store, like §4
git init -b main
eventmodelers init --stack dcb --hooks        # credentials: type 4 (Skip for now)
bash scripts/start-empty.sh
npm install
ls .githooks && git config core.hooksPath     # → pre-commit, and a path ending in .githooks

emcli workspace init "Library Lending"
emcli skills list                             # → event-model  linked
cp .env.example .env
sed -i.bak '/^workspace.json$/d' .gitignore && rm .gitignore.bak
printf '.build-kit/.slices/\nralph.log\n' >> .gitignore
```

The differences:

1. **Postgres port.** Another project's Postgres (course enrollment's) may already hold port 5432, and then
   `docker compose up` fails. Give this project 5433. The loop doesn't need it (tests start their own database);
   only running the app does.

   ```bash
   docker ps --format '{{.Names}} {{.Ports}}'        # anything on 5432 already?
   sed -i.bak 's/"5432:5432"/"5433:5432"/' docker-compose.yml && rm docker-compose.yml.bak
   sed -i.bak 's/localhost:5432/localhost:5433/' .env && rm .env.bak
   ```

2. **Board.** Add `PROOPH_BOARD_API_KEY` and `PROOPH_BOARD_WORKSPACE_ID` to `.env` as in §4, but use a **separate
   prooph board workspace** from your other projects, so their pushes can't interfere.

3. **The context name.** The empty scaffold has one code context, `src/contexts/enrollment/`, and `src/index.ts`
   wires it. The chapter's `--context` decides where the loop puts code, and for a new process the skill picks a
   name of its own (`--context lending`). Whether the loop builds cleanly into a new context folder hasn't been
   tried yet (PLAN 13.6). Before the first hand-off, check with `emcli chapter list`.

Then make the first commit, as in §4:

```bash
docker compose up -d postgres
npm run build
git add -A && git commit -m "chore: empty DCB project with an emcli workspace"
```

### How Claude picks the skill

There is no activation word. When Claude Code starts in a project, it reads the **name and description** of every
skill in `.claude/skills/` (not the whole skill). The `event-model` description says it's for describing a business
process, event storming, adding events, commands, read models, screens, fields, scenarios and queries, reviewing a
model, and planning slices for the loop. When what you say matches, Claude loads the full skill and follows it.

- **You can see it happen:** the session shows `Skill(event-model)` before the first `emcli` command. emcli
  commands without that line mean Claude is working without the method; say so.
- **Words that match well:** *"Let's event-storm …"*, *"I want to model how …"*, *"Add to the event model: …"*.
  *"Build me an app for …"* is vaguer and may not match.
- **To be sure:** type `/event-model` followed by what you want, e.g. `/event-model members borrow and return
  books`. That always loads it.

### Start

In **terminal 1**, start Claude Code in the project (`claude`) and describe what you want. Typed or dictated makes
no difference: speech-to-text just fills the same prompt. You never name a command or an ID. The skill asks one
question at a time, and asks once whether it may push to the board as you go. Run the loop in **terminal 2** as
usual, once the skill has planned and exported the first slices.

### What it does, by what you say

| You're… | For example | It… |
|---|---|---|
| **storming** a process | *"Courses get registered, their capacity can change, students register and subscribe."* | adds one slice per event in timeline order, in the system lane, and pushes each round. Then it asks what happens first, what can fail, who acts. |
| **shaping slices** | *"An admin registers the course. Anyone can see a course's details."* | turns event slices into state-change slices (command → event) and adds state-view slices (event → read model), with screens and lanes for the roles |
| **adding detail** | *"A course has an id, a title and a capacity. You can't register it twice."* | adds fields with examples, happy-path and rejection scenarios, routes, queries, read model types |
| **reviewing** | *"Is t1 complete? What's missing?"* | runs `emcli completeness` and the method's checklist, and lists the gaps before changing anything |
| **handing off** | *"Plan these for the loop."* | checks the loop is idle (*waiting*), then plans, pushes, commits and exports, in §5.4's order |

Open questions become **hotspots** on the board (red stickies) instead of guesses. The skill never writes to the
board except through `emcli sync push --safe`, and never commits or exports while the loop is building.

### Increment t0, said instead of typed

| You say | It runs (the §5 commands) |
|---|---|
| *"New chapter: Course Enrollment, context enrollment. Students take part, the system is Enrollment."* | `chapter add`, `use chapter`, three `lane add` (§5.1) |
| *"First, a course gets registered with an id, a title and a capacity."* | `slice add "register course"`, the `courseWasRegistered` event, then the `registerCourse` command that produces it, fields with examples (§5.2) |
| *"Registering works, and registering the same course twice fails with 'Course already exists'."* | two scenarios with `--link --seed-examples` and an error step |
| *"POST to /courses."* | `element update registerCourse --api-endpoint /courses` |
| *"Anyone can look a course up by id."* | the `course details` slice: `CourseDetails` fed by `courseWasRegistered`, route `/courses/{courseId}`, a view scenario (§5.3) |
| *"Plan both for the loop."* | `slice status … planned` ×2, `sync push --safe`, commit, `workspace export --build-kit` (§5.4) |

### Prompt cookbook

| To get… | Say something like |
|---|---|
| a new event on the timeline | *"After a course is registered, its capacity can change."* |
| an event before another | *"Before registration, a course is proposed."* |
| a rename | *"Call it courseWasPublished, not courseWasRegistered."* |
| a command and screen | *"The admin changes the capacity on the course page."* |
| a read model | *"Students need a list of their courses."* |
| a growing read model (copy) | *"The course details should show the new capacity too."* |
| an automation | *"When a student subscribes, send a welcome email."* |
| fields | *"A subscription has the course id and the student id."* |
| a rejection scenario | *"You can't subscribe to a full course: 'Course is full'."* |
| a different example | *"In that scenario the capacity is 40."* |
| a query | *"List the courses with at least N free seats, at /available-courses."* |
| a read model type | *"Seat counts must never be stale."* (inline) / *"Compute it on read."* (live) |
| an open question | *"Not sure yet whether a course can be cancelled with students in it."* |
| a review | *"What's missing before t2 can be built?"* |
| the hand-off | *"Plan subscribe student, keep the details copy as a draft."* |

The skill's own reference, including the phrase-to-command cookbook it works from, is in your emcli checkout:
`skills/event-model/SKILL.md` and `skills/event-model/references/`.

---

## 18. Command reference

Every `<chapter>`, `<slice>`, `<lane>`, `<element>` and `<spec>` below is a **name** (or an ID). Leading ones can be
left out once `emcli use chapter` / `use slice` / `use spec` has set them (§4, *Names, not IDs*).

### emcli (model)

| Command | Purpose |
|---|---|
| `emcli workspace init "<name>"` | create `workspace.json` and link emcli's skills (`--no-skills` to skip) |
| `emcli skills link` / `emcli skills list` | (re)link emcli's skills into `.claude/skills/`, one link each / show them |
| `emcli use chapter\|slice\|spec "<name>"` / `emcli use` | set / show the context |
| `emcli chapter add "<name>" --context <ctx>` | create a chapter |
| `emcli lane add [<chapter>] "<label>" --type user-lane\|information-flow\|system` | add a lane |
| `emcli slice add [<chapter>] "<label>" [--after\|--before <slice>]` | add a slice (at the end, or next to another) |
| `emcli element add [<chapter>] <slice> <lane> command\|event\|information\|ui\|automation\|hotspot "<name>"` | add a sticky (`readmodel`, `screen` also accepted) |
| `emcli element field add [<chapter>] <element> <name> <Type> [--id] [--optional] [--cardinality List] [--subfields "a:String,b:Int"] [--example v] [--mapping src]` | add a field |
| `emcli element update [<chapter>] <element> --api-endpoint "/path"` | set the HTTP route |
| `emcli element update [<chapter>] <element> --read-model-type database-projected\|inline-projected\|live-report` | choose how a read model is kept current (set on the origin; copies follow). On a built read model, the next export re-queues it as a one-line retype |
| `emcli element query add [<chapter>] <readmodel> <name> --endpoint "/path" [--sort <field>]` | declare a query on the origin read model; `update`, `remove`, `list` too |
| `emcli element query param add [<chapter>] <readmodel> <query> <param> <Type> [--operator gte] [--field a.b] [--tag <tag>] [--example v]` | add a query parameter (`--tag` lets a live read model serve it) |
| `emcli element copy [<chapter>] <origin> --slice <slice> --lane <lane>` | place a read-model copy later on the timeline |
| `emcli element update [<chapter>] <element> --copy-of <origin>` | mark an existing sticky as a copy |
| `emcli dependency add <from> <to> produces\|hydrates\|displays\|triggers\|reacts-to\|relates-to` | link stickies |
| `emcli spec add [<chapter>] [<slice>] "<title>"` | add a scenario |
| `emcli spec step add [<chapter> <slice> <spec>] <phase> <type> <name> --link --seed-examples` | add a Given/When/Then step linked to the named element, seeded with its examples (`when query <name> --link <readmodel>` runs a query; `then error "<message>"` is a rejection) |
| `emcli spec step example [<chapter> <slice> <spec>] <phase> <index> <field> <value>` | change one example value |
| `emcli spec show [<chapter>] [<slice>] [<spec>]` | show a scenario with its step indexes |
| `emcli slice status [<chapter>] <slice> draft\|planned\|…` | set a slice's status |
| `emcli completeness [<chapter>] [--slice <slice>]` | check every field traces to a source |
| `emcli sync push --safe` | push local changes to the board (never deletes) |
| `emcli sync pull` | pull board changes (notes, names) into the model |
| `emcli workspace export --build-kit .build-kit --chapter <chapter>` | hand planned slices to the loop |
| `emcli workspace import-status --build-kit .build-kit` | bring the loop's statuses back into the model |

### Build loop and project

| Command | Purpose |
|---|---|
| `eventmodelers init --stack dcb` | scaffold the project and install the kit |
| `bash scripts/start-empty.sh` | remove the bundled example and start empty |
| `eventmodelers run --local 2>&1 \| tee ralph.log` | run the build loop |
| `npm run run:checks -- --staged` | run the commit checks by hand |
| `npm run build && node --env-file=.env dist/index.js` | run the service |
| `npx vitest run src/contexts/enrollment/slices/<slice>` | run one slice's tests |

---

## 19. Known limits

- **The node (Emmett) kit has no extension mode.** This manual covers the DCB kit only.
- **The copy link doesn't survive a pull.** emcli keeps it in `copyOf`, and pushes copies as ordinary stickies.
  prooph board's own copy function does link a copy to its origin (they share `details`), but its API doesn't
  expose that link. So a copy someone makes on the board arrives as an unrelated sticky. Mark it with
  `element update --copy-of <origin>` before exporting, or the loop builds it as a new read model instead of an
  extension.
- **Export re-queues a Done slice only for a retype (§11.3) or added queries (§12.2).** Change a built read model
  in any other way with a new copy, as shown.
- **Live read models serve keyed GETs and tagged queries only**, and need their events and lookups reachable by
  tags (§11.6, §12.1). Their cost grows with one entity's history, times the candidates a query folds.
- **Queries are named, parameterised filters.** No OR conditions, full-text search, aggregates or joins across
  read models (§12.5).
- **Looked-up values are captured when the event that uses them is folded.** A student renamed after subscribing
  keeps the old name in `CourseDetails`, in every type alike.
- **Only `readModel.ts` read models can switch type.** Older `projection.ts` ones need a one-off conversion (§11.2).
- **Inline read models slow writes.** Each one adds its projection's work to every append of the events it
  handles. The kit doesn't measure it for you. Keep them few, and check write latency when you add one.
- **Rebuild time grows with the event store.** Fine for development. For large production stores, plan rebuilds
  deliberately.
