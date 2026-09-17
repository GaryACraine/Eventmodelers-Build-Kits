# Standalone board-change turns

**Read this file only in a `standalone=on` session, and only once the first turn whose first
line is `BOARD_CHANGE` or `BOARD_REVIEW` actually arrives.** It is a one-time read like
`.agent-modeling-kit/CLAUDE.md` itself — don't re-read it on later self-directed turns, don't
read it at all in a `standalone=off` session, and don't read it "to be prepared" while handling
a prompt turn. Nothing in here loosens what you may do on a prompt turn: the fill-in licence
below belongs to turns nobody asked for, and a prompt turn that has this file in its context is
exactly how it starts doing more than it was asked.

Everything else — the connect/resolve rules, the Skill Selection table, the Progress Entry
Format — stays in `.agent-modeling-kit/CLAUDE.md` and still applies.

These turns come in two shapes, and both are self-directed — nobody asked you for anything:

```
BOARD_CHANGE board_id=<uuid> organization_id=<uuid> seq=118..124 events=9 nodes=3
changed:
- 9f3c…: node:created, node:changed (4×)
- a12b…: node:changed (2×) — possibly your own earlier write
- c771…: edge:added (3×)
```

```
BOARD_REVIEW board_id=<uuid> organization_id=<uuid> idle_for=900s
changed: nothing — the board has been quiet.
```

**The change list is a notification, not the work item.** It tells you that something
happened and which corner of the board to look at first — nothing more. It is not a task
list, not a boundary, and the last line of it is not "the" change to react to. A burst of
40 events on 6 nodes and a single `node:created` get the same treatment: you look at the
model, not at the event. A `BOARD_REVIEW` turn is the same job with no starting hint at all.
Nodes marked *possibly your own earlier write* are changes that landed while you were
working or just after — usually your own echo, so weigh them accordingly, but don't assume:
a human may well have been editing at the same time.

**There is no `prompt_id` in these turns — never call `/update-prompt-status` in one** (not
`IN_PROGRESS`, not `DONE`; the "exactly two calls per turn" rule is about prompt turns only).
There is nothing to sanitize either — a board change is not user text.

Steps:

1. **Get the whole picture, not just the changed nodes.** Start at the listed nodes
   (`mcp__eventmodelers__get_node`, or the REST equivalent) and widen out to what they sit
   in — their cell, their slice, the chain they belong to, the timeline around them.
   `mcp__eventmodelers__get_board_events` with the header's `seq` range tells you what the
   change actually was when the node's current state doesn't make it obvious. Then judge the
   board as a whole: run `/analyze-existing-model` once per session to get that picture and
   keep it in mind across turns, refreshing it when a turn's changes invalidate it. On a
   `BOARD_REVIEW` turn that model-wide picture *is* the starting point.
2. **Decide what the model needs — plural, and not necessarily where the change was.** List
   the candidate contributions you can actually see evidence for, each with its own target
   (node/cell/slice) and the skill that does it. A changed node is a reason to look; it is
   not automatically the thing to work on, and work you spot two slices away counts just as
   much. The usual candidates:
   - an EVENT/COMMAND/READMODEL with fields but no example data → `/examples`
   - a COMMAND or READMODEL with no specs on it — no GWT scenarios, no storyline →
     `/eventmodeling-elaborating-scenarios`
   - a field added to one element that its chain neighbours are missing → `/attributes`
   - an empty SCREEN/HTML_SCREEN node → `/html-screen`
   - a timeline element that clearly should be sliced and isn't →
     `/eventmodeling-slicing-event-models`
   - a gap or unhandled case that raises a real business question → one QUESTION comment via
     `/handle-comment` with `action=place`
   Nothing is a candidate when it's cosmetic (a node moved, resized or renamed), when the
   target already has the thing you'd add, when it's inside something you yourself just
   wrote, or when the element is still visibly half-finished in itself (a placeholder name,
   no fields yet — there is nothing to fill in). An empty candidate list is a perfectly good
   outcome — see step 8.

   **Fill it in now, or ask first? — there are only these two tiers.**

   *Fill-in work — just do it, on this self-directed turn, without asking.* Every candidate above is additive,
   scoped to one element or one chain, and leaves the human's structure exactly as they built
   it: examples, specs, an attribute along a chain, a screen, one question comment. This is
   what a standalone session is *for* — the human models the shape, you fill in the detail
   behind them while they keep going. A node created sixty seconds ago is the **best** target
   for it, not a reason to wait: they placed a READMODEL with fields and moved straight on to
   the next column, and its specs and example data are precisely what they didn't stop to
   write. All of it is cheap to undo — one gesture on the canvas, or one prompt — so guessing
   slightly wrong costs far less than a board that stays empty while the agent watches.

   *Board-wide or structural work — name it in a comment, then get on with the fill-in work.*
   Sweeping every chapter at once, renaming, re-shaping or deleting anything, moving slice
   statuses, reordering a timeline: post one comment saying what you'd run and why, and spend
   the turn on tier one instead. Never make the structural move on your own initiative.

   **Freshness is not a reason to hold back, and neither is an unanswered question.** The CLI
   already waited for the board to go quiet before handing you this turn — a debounce after
   the last event, the echo window, and a minimum gap between turns — and that *is* the
   mid-edit guard. Do not add a second one on top of it: "the human is still working" describes
   every good standalone turn, not an exception to it. Equally, a question you posted on an
   earlier turn parks the one structural sweep you asked about and nothing else. It never
   becomes a standing hold on fill-in work, and you never wait across turns for an answer —
   nobody reads your turn output, only the board.
3. **Spawn a subagent for each piece of work that needs doing — and only where one does.** The
   analysis in steps 1–2 is yours: you look at every entry in `changed:` yourself, in the
   context of the model, and decide what (if anything) needs to happen. Then, for each
   candidate that survived that judgment, dispatch one subagent via the `Agent` tool, **with
   all of them in a single message** so they run in parallel. Entries that need nothing spawn
   nothing; a turn where nothing needs doing spawns nothing at all and ends in a `NOOP`. What
   you must never do is work the candidates one after another in your own turn, or pick one
   out of five and drop the rest — nine events on three nodes that each need something are
   three agents working at once. You analyse and coordinate; the agents do the work.
   Each subagent prompt must be self-contained, because a subagent is a fresh session that
   inherits none of this one's state:
   - `token=`, `org=`, `baseUrl=` from this session's first message, and the instruction to
     run `/connect` first;
   - `board_id`, plus the exact target ids (`node_id`/`cellName`/`timelineId`/slice) it owns
     — never "the node that changed";
   - what you concluded in step 2: the specific piece of work, and enough of the surrounding
     model for the agent to do it well;
   - the one skill to invoke, from the Skill Selection table in `.agent-modeling-kit/CLAUDE.md`,
     and the same rule that applies to you: invoke the skill, don't substitute raw MCP calls;
   - the questioning rule: nobody is there to answer, so it must never ask interactively (no
     `AskUserQuestion`, even where a skill lists it) — it posts a comment on its target and
     continues with the best reading of the work you gave it;
   - the standing constraints of step 4 and step 5 below.
   **Stay inside the agent budget.** The session header carries `max_agents=<n>` (default 5)
   and every self-directed turn restates it: that is the most Agents you may dispatch in one
   turn, because a turn nobody asked for still costs money. Merge by area first (step 4) —
   that's a correctness rule, not a way to fit the budget — and if more pieces are still left
   than the cap allows, dispatch the most valuable ones and leave the rest; the board doesn't
   forget, and a later turn will see them again. With `max_agents=1`, spawn nothing at all and
   do the single most valuable piece yourself, inline.
   **The decision stays with you.** A subagent is an executor, not a second judge: it carries
   out the piece of work you decided on, on the target you named, and nothing else. It does
   not re-open the question of whether the work is worth doing, does not widen its scope, and
   does not go looking for other things on the board. If it finds the work doesn't apply after
   all — the node already has what you'd add, someone is mid-edit — it reports that back to
   you instead of substituting work of its own, and you decide what happens next.
   Do the work inline yourself only when exactly one candidate survived and it is small (one
   comment, one `/examples` call) — spawning a single agent for a single small thing is pure
   overhead.
4. **Give every agent its own territory — merge before you dispatch, never split a slice.**
   Two agents writing into the same node, chain or slice will clobber each other and the board
   has no merge. So the mapping from step 3 is subject to one rule: candidates that live in
   the same slice or the same chain are handled by **one** agent that owns that whole area,
   with all of their work in its brief, not one agent each. That also keeps a big burst sane —
   work on 30 changed nodes across 4 slices is 4 agents, well inside the default budget. Merge
   first, then prioritize: a candidate is only ever deferred to a later turn because the budget
   ran out, never because it was inconvenient to merge.
5. **Never undo or overwrite human work** — you and every agent you dispatch. You add to the
   board; you don't delete, rename, restructure timelines, or move slice statuses on your own
   initiative. If the right move would be destructive, post a comment saying so instead.
6. **If you already said it, don't say it again.** Before posting a comment — or having a
   subagent post one — read the node's existing comments. An unresolved question already
   there means that contribution is on the board.
7. **Write no progress entry.** A self-directed turn is modeling, not tracked progress —
   nothing goes into `progress.txt` here (that file belongs to prompt turns, which answer to
   someone who asked). Still promote anything reusable to `.agent-modeling-kit/AGENTS.md`
   (same as step 9 of a prompt turn in `.agent-modeling-kit/CLAUDE.md`), including anything a
   subagent reported back.
8. Reply `<promise>DONE</promise>`, naming what you dispatched and what each agent did, or —
   when step 2 turned up nothing worth doing — change nothing at all and reply
   `<promise>NOOP</promise>`. A NOOP is a perfectly good outcome, and the CLI widens the gap
   before the next self-directed turn each time you answer one, so a finished board goes
   quiet by itself. Don't manufacture work to avoid a NOOP — but don't reach for one either:
   a NOOP means the fill-in list in step 2 genuinely came up empty, every element that could
   carry examples, specs, attributes or a screen already having them. Someone editing the
   board right now is not a NOOP, and neither is waiting on an answer to something you asked.
   Walk the newest nodes against that list before you answer one.

Keep these turns finished within the turn: wait for the subagents you dispatched, don't leave
work trailing. Everything you and they write to the board comes back on this same channel as
another change; the CLI labels changes that arrive in that echo window rather than dropping
them, so you'll see your own writes listed on a later turn — recognize them and don't rework
them.
