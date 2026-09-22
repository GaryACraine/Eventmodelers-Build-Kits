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
5. [Increment t0: register a course, see its details](#5-increment-t0--register-a-course-see-its-details)
6. [Increment t1: capacity changes (your first growing read model)](#6-increment-t1--capacity-changes-your-first-growing-read-model)
7. [Increment t2: students subscribe (a new field and a lookup)](#7-increment-t2--students-subscribe-a-new-field-and-a-lookup)
8. [Client feedback through the board](#8-client-feedback-through-the-board)
9. [Increments t3 and t4](#9-increments-t3-and-t4)
10. [Working with git: branches, commits and merges](#10-working-with-git-branches-commits-and-merges)
11. [How the Ralph loop builds a slice](#11-how-the-ralph-loop-builds-a-slice)
12. [Rebuilds in depth](#12-rebuilds-in-depth)
13. [Troubleshooting](#13-troubleshooting)
14. [Command reference](#14-command-reference)
15. [Known limits](#15-known-limits)

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
eventmodelers init --stack dcb
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

Install dependencies. This also switches on the **pre-commit hook**, which checks every slice commit (see
[§11](#11-how-the-ralph-loop-builds-a-slice)):

```bash
npm install
git config core.hooksPath            # → .githooks
```

Create the model workspace and the environment file:

```bash
emcli workspace init "Course Enrollment" --no-skills
cp .env.example .env
```

`--no-skills` stops emcli from replacing `.claude/skills` (the build kit's skills are already there).

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

### Helpers for looking things up by name

Every emcli element has an ID. **IDs change the first time you push to the board**: emcli's local IDs are
replaced by the board's. So never write IDs down. Look them up by name whenever you need one. Save these
helpers as `em-helpers.sh` in the project:

```bash
cat > em-helpers.sh <<'EOF'
# Source me:  source em-helpers.sh
# Name-based lookups into workspace.json, scoped to one chapter.
CHAPTER="Course Enrollment"
_ch='.chapters[] | select(.name == $c)'
chapter_id() { jq -r --arg c "$CHAPTER" "$_ch | .id" workspace.json; }
lane_id()    { jq -r --arg c "$CHAPTER" --arg l "$1" "$_ch | .lanes[] | select(.label == \$l) | .id" workspace.json; }
slice_id()   { jq -r --arg c "$CHAPTER" --arg l "$1" "$_ch | .slices[] | select(.label == \$l) | .id" workspace.json; }
# el_id "<slice label>" <command|event|information> <name>
el_id() {
  local s; s=$(slice_id "$1")
  jq -r --arg c "$CHAPTER" --arg s "$s" --arg t "$2" --arg n "$3" \
    "$_ch | .elements[] | select(.sliceId == \$s and .type == \$t and .name == \$n) | .id" workspace.json
}
# Scenario (Given/When/Then) helpers
# step "<slice>" <spec-id> <given|when|then> <event|command|readmodel> <element-id>
step()    { emcli spec step add "$(chapter_id)" "$(slice_id "$1")" "$2" "$3" "$4" x --link "$5" --seed >/dev/null; }
# error_step "<slice>" <spec-id> "<error message>"
error_step() { emcli spec step add "$(chapter_id)" "$(slice_id "$1")" "$2" then error "$3" >/dev/null; }
# ex "<slice>" <spec-id> <phase> <step index> <field> <value>
ex()      { emcli spec step example "$(chapter_id)" "$(slice_id "$1")" "$2" "$3" "$4" "$5" "$6" >/dev/null; }
EOF
echo "source em-helpers.sh" >> ~/.bashrc   # optional; otherwise run `source em-helpers.sh` in each new shell
source em-helpers.sh
git add em-helpers.sh && git commit -m "chore: name-based emcli helpers"
```

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
[§10](#10-working-with-git-branches-commits-and-merges)):

```bash
git switch -c increment/t0
```

(`git switch -c <name>` creates a branch from where you are and moves you onto it.)

### 5.1 Chapter and lanes

A **chapter** is one board page. **Lanes** are the horizontal rows: people at the top, commands and read
models in the middle, events at the bottom.

```bash
emcli chapter add "Course Enrollment" --context enrollment
emcli lane add "$(chapter_id)" Student --type user-lane
emcli lane add "$(chapter_id)" Enrollment --type information-flow
emcli lane add "$(chapter_id)" "Enrollment Events" --type system
```

`--context enrollment` names the code's bounded context. Generated code lands in `src/contexts/enrollment/`.

### 5.2 The *register course* slice (state change)

```bash
emcli slice add "$(chapter_id)" "register course"
emcli element add "$(chapter_id)" "$(slice_id 'register course')" "$(lane_id Enrollment)" command registerCourse
emcli element add "$(chapter_id)" "$(slice_id 'register course')" "$(lane_id 'Enrollment Events')" event courseWasRegistered
```

**Fields** are the data a sticky carries. The command and the event carry the same three:

```bash
for el in "$(el_id 'register course' command registerCourse)" "$(el_id 'register course' event courseWasRegistered)"; do
  emcli element field add "$(chapter_id)" "$el" courseId String --id --example c1
  emcli element field add "$(chapter_id)" "$el" title String --example Math
  emcli element field add "$(chapter_id)" "$el" capacity Int --example 30
done
```

`--id` marks `courseId` as the identity. The kit turns it into the event's tag (`courseId=c1`).

Link command → event (*"registerCourse produces courseWasRegistered"*), and give the command its HTTP route:

```bash
emcli dependency add "$(el_id 'register course' command registerCourse)" "$(el_id 'register course' event courseWasRegistered)" produces
emcli element update "$(chapter_id)" "$(el_id 'register course' command registerCourse)" --api-endpoint "/courses"
```

#### Scenarios: the slice's specification

A **scenario** (Given / When / Then) is an executable example: *given* these past events, *when* this command
arrives, *then* this event is recorded (or this error). The build loop turns each scenario into a test.

```bash
REG_CMD=$(el_id 'register course' command registerCourse)
REG_EVT=$(el_id 'register course' event courseWasRegistered)

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'register course')" "registers a new course" --json | jq -r .id)
step "register course" "$sp" when command "$REG_CMD"
step "register course" "$sp" then event   "$REG_EVT"
for ph in when then; do
  ex "register course" "$sp" $ph 0 courseId c1; ex "register course" "$sp" $ph 0 title Math; ex "register course" "$sp" $ph 0 capacity 30
done

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'register course')" "rejects a course that is already registered" --json | jq -r .id)
step "register course" "$sp" given event "$REG_EVT"
step "register course" "$sp" when  command "$REG_CMD"
error_step "register course" "$sp" "Course already exists"
for ph in given when; do
  ex "register course" "$sp" $ph 0 courseId c1; ex "register course" "$sp" $ph 0 title Math; ex "register course" "$sp" $ph 0 capacity 30
done
```

Check the scenarios read the way you intend:

```bash
emcli spec list "$(chapter_id)" "$(slice_id 'register course')"
```

### 5.3 The *course details* slice (state view)

```bash
emcli slice add "$(chapter_id)" "course details"
emcli element add "$(chapter_id)" "$(slice_id 'course details')" "$(lane_id Enrollment)" information CourseDetails
DETAILS=$(el_id 'course details' information CourseDetails)
emcli element field add "$(chapter_id)" "$DETAILS" courseId String --id --example c1
emcli element field add "$(chapter_id)" "$DETAILS" title String --example Math
emcli element field add "$(chapter_id)" "$DETAILS" capacity Int --example 30
emcli dependency add "$REG_EVT" "$DETAILS" hydrates                       # the event feeds the read model
emcli element update "$(chapter_id)" "$DETAILS" --api-endpoint "/courses/{courseId}"

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'course details')" "shows a registered course" --json | jq -r .id)
step "course details" "$sp" given event     "$REG_EVT"
step "course details" "$sp" then  readmodel "$DETAILS"
for ph in given then; do
  ex "course details" "$sp" $ph 0 courseId c1; ex "course details" "$sp" $ph 0 title Math; ex "course details" "$sp" $ph 0 capacity 30
done
```

A state-view scenario says: *given* these events, *then* the read model shows this.

### 5.4 Plan, push, commit, export

Mark both slices **planned**. That's the signal for the loop to build them:

```bash
emcli slice status "$(chapter_id)" "$(slice_id 'register course')" planned
emcli slice status "$(chapter_id)" "$(slice_id 'course details')" planned
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

The push replaced every local ID with the board's, which is why the helpers look everything up by name.
**Commit before exporting.** The loop shares your working tree, and you don't want your model files swept
into its commits:

```bash
git add -A && git commit -m "model(t0): register course + course details"
```

**Export** the planned slices to the build loop:

```bash
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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
emcli slice add "$(chapter_id)" "change course capacity"
emcli element add "$(chapter_id)" "$(slice_id 'change course capacity')" "$(lane_id Enrollment)" command changeCourseCapacity
emcli element add "$(chapter_id)" "$(slice_id 'change course capacity')" "$(lane_id 'Enrollment Events')" event courseCapacityWasChanged
CAP_CMD=$(el_id 'change course capacity' command changeCourseCapacity)
CAP_EVT=$(el_id 'change course capacity' event courseCapacityWasChanged)
REG_EVT=$(el_id 'register course' event courseWasRegistered)
for el in "$CAP_CMD" "$CAP_EVT"; do
  emcli element field add "$(chapter_id)" "$el" courseId String --id --example c1
  emcli element field add "$(chapter_id)" "$el" newCapacity Int --example 40
done
emcli dependency add "$CAP_CMD" "$CAP_EVT" produces
emcli element update "$(chapter_id)" "$CAP_CMD" --api-endpoint "/courses/{courseId}/capacity"

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'change course capacity')" "changes the capacity of a registered course" --json | jq -r .id)
step "change course capacity" "$sp" given event   "$REG_EVT"
step "change course capacity" "$sp" when  command "$CAP_CMD"
step "change course capacity" "$sp" then  event   "$CAP_EVT"
ex "change course capacity" "$sp" given 0 courseId c1; ex "change course capacity" "$sp" given 0 title Math; ex "change course capacity" "$sp" given 0 capacity 30
for ph in when then; do ex "change course capacity" "$sp" $ph 0 courseId c1; ex "change course capacity" "$sp" $ph 0 newCapacity 40; done

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'change course capacity')" "rejects a capacity change for an unknown course" --json | jq -r .id)
step "change course capacity" "$sp" when command "$CAP_CMD"
error_step "change course capacity" "$sp" "Course not found"
ex "change course capacity" "$sp" when 0 courseId c9; ex "change course capacity" "$sp" when 0 newCapacity 40
```

The *given* in the first scenario uses `courseWasRegistered`, an event from a different slice. That's normal.
Deciders read whatever past events they need.

### 6.2 Copy the read model forward

`CourseDetails` must now also react to `courseCapacityWasChanged`. Don't draw an arrow back to the original
sticky. Place a **copy** after the new event, in a new slice:

```bash
emcli slice add "$(chapter_id)" "course details capacity"
emcli element copy "$(chapter_id)" "$(el_id 'course details' information CourseDetails)" \
  --slice "$(slice_id 'course details capacity')" --lane "$(lane_id Enrollment)"
DETAILS_1=$(el_id 'course details capacity' information CourseDetails)
emcli dependency add "$REG_EVT" "$DETAILS_1" hydrates
emcli dependency add "$CAP_EVT" "$DETAILS_1" hydrates
```

The copy inherits the original's fields and remembers its origin (`copyOf`). Wire **every** event that shapes
the read model so far, not just the new one. A copy shows the read model's complete inputs at that point in
time. emcli works out what's new by comparing with the previous copy.

```bash
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'course details capacity')" "shows the changed capacity" --json | jq -r .id)
step "course details capacity" "$sp" given event     "$REG_EVT"
step "course details capacity" "$sp" given event     "$CAP_EVT"
step "course details capacity" "$sp" then  readmodel "$DETAILS_1"
ex "course details capacity" "$sp" given 0 courseId c1; ex "course details capacity" "$sp" given 0 title Math; ex "course details capacity" "$sp" given 0 capacity 30
ex "course details capacity" "$sp" given 1 courseId c1; ex "course details capacity" "$sp" given 1 newCapacity 40
ex "course details capacity" "$sp" then 0 courseId c1; ex "course details capacity" "$sp" then 0 title Math; ex "course details capacity" "$sp" then 0 capacity 40
```

### 6.3 Stage it: ship the command first, keep the extension as a draft

Plan the new command now, but leave the extension as **draft**. The loop ignores drafts. This mirrors real
life: the capacity feature ships and gets used before the read model catches up. It's also exactly the
situation the automatic rebuild is designed for (§6.6).

```bash
emcli slice status "$(chapter_id)" "$(slice_id 'change course capacity')" planned
emcli slice status "$(chapter_id)" "$(slice_id 'course details capacity')" draft
emcli sync push --safe
git add -A && git commit -m "model(t1): change course capacity + CourseDetails copy (draft)"
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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
emcli slice status "$(chapter_id)" "$(slice_id 'course details capacity')" planned
emcli sync push --safe
git add -A && git commit -m "model(t1): plan course details capacity"
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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

1. Opens the **origin's** `projection.ts` and checks the new event isn't handled already.
2. Appends it to `canHandle` and adds one `case` for it. It never edits existing code.
3. Adds any new fields to the route's response, with defaults for older data.
4. Appends a `describe("course details capacity")` test block to the origin's test file.
5. Commits. The pre-commit hook's **extension-additive** check rejects any edit or deletion of existing
   projection code, and **slice-tests** runs the whole test file, so every earlier scenario must still pass.

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
You don't do anything; §12 has the details.

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
REG_EVT=$(el_id 'register course' event courseWasRegistered)
CAP_EVT=$(el_id 'change course capacity' event courseCapacityWasChanged)
```

### 7.1 Two new state-change slices

```bash
# register student
emcli slice add "$(chapter_id)" "register student"
emcli element add "$(chapter_id)" "$(slice_id 'register student')" "$(lane_id Enrollment)" command registerStudent
emcli element add "$(chapter_id)" "$(slice_id 'register student')" "$(lane_id 'Enrollment Events')" event studentWasRegistered
RS_CMD=$(el_id 'register student' command registerStudent); RS_EVT=$(el_id 'register student' event studentWasRegistered)
for el in "$RS_CMD" "$RS_EVT"; do
  emcli element field add "$(chapter_id)" "$el" studentId String --id --example s1
  emcli element field add "$(chapter_id)" "$el" name String --example Ada
done
emcli dependency add "$RS_CMD" "$RS_EVT" produces
emcli element update "$(chapter_id)" "$RS_CMD" --api-endpoint "/students"
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'register student')" "registers a new student" --json | jq -r .id)
step "register student" "$sp" when command "$RS_CMD"; step "register student" "$sp" then event "$RS_EVT"
for ph in when then; do ex "register student" "$sp" $ph 0 studentId s1; ex "register student" "$sp" $ph 0 name Ada; done
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'register student')" "rejects a student that is already registered" --json | jq -r .id)
step "register student" "$sp" given event "$RS_EVT"; step "register student" "$sp" when command "$RS_CMD"
error_step "register student" "$sp" "Student already exists"
for ph in given when; do ex "register student" "$sp" $ph 0 studentId s1; ex "register student" "$sp" $ph 0 name Ada; done

# subscribe student
emcli slice add "$(chapter_id)" "subscribe student"
emcli element add "$(chapter_id)" "$(slice_id 'subscribe student')" "$(lane_id Enrollment)" command subscribeStudent
emcli element add "$(chapter_id)" "$(slice_id 'subscribe student')" "$(lane_id 'Enrollment Events')" event studentWasSubscribed
SUB_CMD=$(el_id 'subscribe student' command subscribeStudent); SUB_EVT=$(el_id 'subscribe student' event studentWasSubscribed)
for el in "$SUB_CMD" "$SUB_EVT"; do
  emcli element field add "$(chapter_id)" "$el" courseId String --id --example c1
  emcli element field add "$(chapter_id)" "$el" studentId String --id --example s1
done
emcli dependency add "$SUB_CMD" "$SUB_EVT" produces
emcli element update "$(chapter_id)" "$SUB_CMD" --api-endpoint "/courses/{courseId}/students"
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'subscribe student')" "subscribes a registered student to a registered course" --json | jq -r .id)
step "subscribe student" "$sp" given event "$REG_EVT"; step "subscribe student" "$sp" given event "$RS_EVT"
step "subscribe student" "$sp" when command "$SUB_CMD"; step "subscribe student" "$sp" then event "$SUB_EVT"
ex "subscribe student" "$sp" given 0 courseId c1; ex "subscribe student" "$sp" given 0 title Math; ex "subscribe student" "$sp" given 0 capacity 30
ex "subscribe student" "$sp" given 1 studentId s1; ex "subscribe student" "$sp" given 1 name Ada
for ph in when then; do ex "subscribe student" "$sp" $ph 0 courseId c1; ex "subscribe student" "$sp" $ph 0 studentId s1; done
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'subscribe student')" "rejects a subscription to an unknown course" --json | jq -r .id)
step "subscribe student" "$sp" given event "$RS_EVT"; step "subscribe student" "$sp" when command "$SUB_CMD"
error_step "subscribe student" "$sp" "Course not found"
ex "subscribe student" "$sp" given 0 studentId s1; ex "subscribe student" "$sp" given 0 name Ada
ex "subscribe student" "$sp" when 0 courseId c9; ex "subscribe student" "$sp" when 0 studentId s1
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'subscribe student')" "rejects a subscription for an unknown student" --json | jq -r .id)
step "subscribe student" "$sp" given event "$REG_EVT"; step "subscribe student" "$sp" when command "$SUB_CMD"
error_step "subscribe student" "$sp" "Student not found"
ex "subscribe student" "$sp" given 0 courseId c1; ex "subscribe student" "$sp" given 0 title Math; ex "subscribe student" "$sp" given 0 capacity 30
ex "subscribe student" "$sp" when 0 courseId c1; ex "subscribe student" "$sp" when 0 studentId s9
```

### 7.2 The second copy: a new field with a nested shape

```bash
emcli slice add "$(chapter_id)" "course details subscriptions"
emcli element copy "$(chapter_id)" "$(el_id 'course details' information CourseDetails)" \
  --slice "$(slice_id 'course details subscriptions')" --lane "$(lane_id Enrollment)"
DETAILS_2=$(el_id 'course details subscriptions' information CourseDetails)
emcli element field add "$(chapter_id)" "$DETAILS_2" subscribedStudents Custom --cardinality List \
  --subfields "studentId:String,name:String" --example '[{"studentId":"s1","name":"Ada"}]'
for e in "$REG_EVT" "$CAP_EVT" "$RS_EVT" "$SUB_EVT"; do emcli dependency add "$e" "$DETAILS_2" hydrates; done
```

`Custom` + `--cardinality List` + `--subfields` describes a list of `{ studentId, name }` objects. All four
events are wired (cumulative). emcli will report `studentWasRegistered` and `studentWasSubscribed` as added,
measured against the *previous copy*, not the origin.

```bash
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'course details subscriptions')" "lists a subscribed student by name" --json | jq -r .id)
step "course details subscriptions" "$sp" given event "$REG_EVT"
step "course details subscriptions" "$sp" given event "$RS_EVT"
step "course details subscriptions" "$sp" given event "$SUB_EVT"
step "course details subscriptions" "$sp" then readmodel "$DETAILS_2"
ex "course details subscriptions" "$sp" given 0 courseId c1; ex "course details subscriptions" "$sp" given 0 title Math; ex "course details subscriptions" "$sp" given 0 capacity 30
ex "course details subscriptions" "$sp" given 1 studentId s1; ex "course details subscriptions" "$sp" given 1 name Ada
ex "course details subscriptions" "$sp" given 2 courseId c1; ex "course details subscriptions" "$sp" given 2 studentId s1
ex "course details subscriptions" "$sp" then 0 courseId c1; ex "course details subscriptions" "$sp" then 0 subscribedStudents '[{"studentId":"s1","name":"Ada"}]'

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'course details subscriptions')" "a course with no subscriptions lists no students" --json | jq -r .id)
step "course details subscriptions" "$sp" given event "$REG_EVT"
step "course details subscriptions" "$sp" then readmodel "$DETAILS_2"
ex "course details subscriptions" "$sp" given 0 courseId c1; ex "course details subscriptions" "$sp" given 0 title Math; ex "course details subscriptions" "$sp" given 0 capacity 30
ex "course details subscriptions" "$sp" then 0 courseId c1; ex "course details subscriptions" "$sp" then 0 subscribedStudents '[]'
```

### 7.3 Ship the write slices first, then the extension

```bash
emcli slice status "$(chapter_id)" "$(slice_id 'register student')" planned
emcli slice status "$(chapter_id)" "$(slice_id 'subscribe student')" planned
emcli slice status "$(chapter_id)" "$(slice_id 'course details subscriptions')" draft
emcli sync push --safe
git add -A && git commit -m "model(t2): students (planned) + CourseDetails copy (draft)"
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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
emcli slice status "$(chapter_id)" "$(slice_id 'course details subscriptions')" planned
emcli sync push --safe
git add -A && git commit -m "model(t2): plan course details subscriptions"
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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

Your local model is the source of truth for structure. The board is where people see it and comment on it.

> **Important:** `sync pull` imports **every chapter** in the board workspace, including other people's. That's
> why every export in this manual uses `--chapter "$(chapter_id)"`, and why the helpers only look inside
> `$CHAPTER`. Without `--chapter`, slices from other chapters could reach the build loop.

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
[`docs/examples/t3.sh`](examples/t3.sh) and [`docs/examples/t4.sh`](examples/t4.sh). They use the same helpers
and follow the same pattern as §6–§7. The git and loop steps around them are the same every time.

**t3**, from `main` in terminal 1:

```bash
git switch -c increment/t3
git add -A && git commit -m "model: pull client note"          # the §8 pull
bash ~/Projects/Eventmodelers-Build-Kits/docs/examples/t3.sh
emcli sync push --safe
git add -A && git commit -m "model(t3): unsubscribe student + CourseDetails copy (draft)"
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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
emcli slice status "$(chapter_id)" "$(slice_id 'course details unsubscriptions')" planned
emcli sync push --safe
git add -A && git commit -m "model(t3): plan course details unsubscriptions"
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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

## 10. Working with git: branches, commits and merges

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
emcli workspace export --build-kit .build-kit --chapter "$(chapter_id)"
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
| An interrupted slice left uncommitted files | `git stash push -u -m "interrupted slice"` and reset the slice to Planned (see Troubleshooting) |

---

## 11. How the Ralph loop builds a slice

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

**The pre-commit hook** (installed by `npm install`) runs the same checks on every commit that touches a slice
folder, so nothing can skip them:

| Check | Rejects |
|---|---|
| blocked-paths | slice commits that touch `package.json` or `src/index.ts` |
| slice-scope | changes outside the slice's own folder |
| extension-additive | an extension that edits or removes existing projection code, or lacks its test block |
| test-file-present | code without a test file |
| no-invented-fields | fields not in `slice.json` (heuristic) |
| spec-coverage | fewer tests than scenarios |
| tsc-build | TypeScript errors |
| slice-tests | failing tests in any slice folder the commit touches |

If a check fails, the agent must fix the code, or set the slice to **Blocked** with the reason. It never
commits over a failure.

**Branches:** the loop never creates, switches or merges branches. It builds on whatever is checked out. That's
why each increment starts with `git switch -c increment/<name>` (see [§10](#10-working-with-git-branches-commits-and-merges)).

**Statuses:** only `planned` slices are built. `draft` (exported as `Created`) is ignored, which lets you stage
work. Once the loop has marked a slice InProgress, Done or Blocked, re-exporting keeps that status.

---

## 12. Rebuilds in depth

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

**Cost:** a rebuild replays all the events this projection handles, so startup waits for it. That's
instantaneous in this example, and it grows with your event store.

---

## 13. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Chapter not found: <id>` from a script | IDs changed on the first push | look IDs up by name (the helpers) |
| `400 Only one information-flow lane is allowed per chapter` on the first push | an old emcli without new-chapter support | update emcli (`git pull` in the emcli repo) |
| `sync diff` prints "No sync baseline found" | nothing has been pushed yet | push once. The first push has no preview |
| the loop builds nothing | no `planned` slices in the current context, or the export was skipped | set status `planned`, `sync push`, commit, then `workspace export --build-kit … --chapter …` |
| a slice stays `Created` | it's `draft` in the model | `emcli slice status … planned`, then re-export |
| a Done slice doesn't rebuild after re-planning | loop-owned statuses win on export | model the change as a new copy/extension slice |
| a slice goes **Blocked** | a check failed and the agent couldn't fix it | read the reason in `.build-kit/.slices/<ctx>/index.json`, fix the model or code, set it back to `planned` |
| commit rejected: `[slice-tests]` | a test fails | fix it. The message names the failing scenario |
| commit rejected: `[extension-additive]` | an extension changed existing projection code | keep extensions to additions only |
| a read model is missing older data after an extension | the app wasn't restarted, so no rebuild | restart the app and look for `Rebuilding …` |
| slices from other chapters appear in `.build-kit/.slices` | exported without `--chapter` after a `sync pull` | re-export with `--chapter "$(chapter_id)"` |
| `eventmodelers init` crashes with `ERR_USE_AFTER_CLOSE` | no terminal input was available | run it in an interactive terminal and answer the prompts |
| a slice stays **InProgress** and the loop says *waiting* | the agent was interrupted mid-slice (Claude usage ran out, the terminal closed). The loop retries a failed agent every 60 s, but the retried agent only builds `Planned` slices | once Claude is available again: `git stash push -u -m "interrupted slice"`, then set the slice back to Planned: `jq '(.slices[] \| select(.status == "InProgress")) \|= (.status = "Planned" \| .definition.status = "Planned")' .build-kit/.slices/enrollment/index.json > /tmp/i.json && mv /tmp/i.json .build-kit/.slices/enrollment/index.json`. Within 10 s the loop rebuilds it from scratch (restart the loop if you closed it) |

---

## 14. Command reference

### emcli (model)

| Command | Purpose |
|---|---|
| `emcli workspace init "<name>" --no-skills` | create `workspace.json` |
| `emcli chapter add "<name>" --context <ctx>` | create a chapter |
| `emcli lane add <chapter> "<label>" --type user-lane\|information-flow\|system` | add a lane |
| `emcli slice add <chapter> "<label>"` | add a slice at the end of the timeline |
| `emcli element add <chapter> <slice> <lane> command\|event\|information "<name>"` | add a sticky |
| `emcli element field add <chapter> <element> <name> <Type> [--id] [--optional] [--cardinality List] [--subfields "a:String,b:Int"] [--example v]` | add a field |
| `emcli element update <chapter> <element> --api-endpoint "/path"` | set the HTTP route |
| `emcli element copy <chapter> <origin> --slice <slice> --lane <lane>` | place a read-model copy later on the timeline |
| `emcli element update <chapter> <element> --copy-of <origin>` | mark an existing sticky as a copy |
| `emcli dependency add <from> <to> produces\|hydrates\|triggers` | link stickies |
| `emcli spec add <chapter> <slice> "<title>" --json` | add a scenario |
| `emcli spec step add <chapter> <slice> <spec> <phase> <type> <title> [--link <el> --seed]` | add a Given/When/Then step |
| `emcli spec step example <chapter> <slice> <spec> <phase> <index> <field> <value>` | set an example value |
| `emcli slice status <chapter> <slice> draft\|planned\|…` | set a slice's status |
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

## 15. Known limits

- **Only emcli adds `extends`.** Slices exported from the eventmodelers platform don't carry it yet, so extension
  mode works only with emcli-sourced slices.
- **The node (Emmett) kit has no extension mode.** This manual covers the DCB kit only.
- **Copies on the board are ordinary stickies.** The "copy" relationship lives in emcli (`copyOf`), not on prooph
  board.
- **Done slices can't be re-queued by export.** Change a built read model with a new copy, as shown.
- **Rebuild time grows with the event store.** Fine for development. For large production stores, plan rebuilds
  deliberately.
