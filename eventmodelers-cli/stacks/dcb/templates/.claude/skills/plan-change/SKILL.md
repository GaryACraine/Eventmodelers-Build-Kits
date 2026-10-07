---
name: plan-change
description: The rules for changing what's already modelled or built. Use before you change, rename, remove, replace, split or merge a slice, command, event, read model, automation or screen; before changing an event's fields or versioning an event; before deprecating or retiring an endpoint or automation; when re-planning a slice the loop blocked; or when deciding whether a change needs its own slice or its own command. Says what is allowed for a slice not yet built, built but not released, and released (deployed).
---

# Plan a change

> **Draft** (PLAN 16.6): written from ADR-017, 018, 019, 039, 046 and 048. Its first use was licensing's "assign organisation
> owner", replaced before release because its command took `roleId` from the caller. That use added the same-name
> replacement below, and "A change other slices use" (expand, switch, contract) after the replacement broke a slice
> that issues the command. **Proven (2026-10-07):** licensing's ADR-049 change went through all three steps in the
> loop (a new command; the translation and the cancellation's automation switched to it; the old slice removed), and
> its end-to-end run passes 44 of 44. It found that a replacement must reach the loop as a rebuild (emcli queues it so
> now). Ready to distil.

A model keeps changing after slices are built. These rules say what a change may do, given how far its slice has
got. The why is in the kit's `ADR.md` (index at the end): this skill is the what. Model through the `event-model`
skill (emcli) as usual; this skill decides *what* to change before you run anything.

## 1. Find the status of everything the change touches

```bash
emcli slice list "<chapter>"                       # each slice's status
grep -l '"Done"' .build-kit/.slices/*/*.json       # built by the loop (backend or UI)
```

| Status | emcli status | Means |
|---|---|---|
| **Not built** | `draft`, `planned`, `blocked`, and not Done in `.build-kit/.slices` | Only the model has it. |
| **Built** | `ready`, `reviewed`, or Done in `.build-kit/.slices` | Code exists, but no real event store has its events. |
| **Released** | `deployed` | Its events are in a real event store, and clients may call its endpoints. |

The change's status is the **most advanced** status among everything it touches, **including every slice that
produces or reads the same event**. An event is released once any slice holding it is.

## 2. What to do

| The change | Not built | Built, not released | Released |
|---|---|---|---|
| Add or change a field, rule, spec or example | Edit the slice | **A new slice** (an extension slice when a read model gains an event or field, ADR-019) | A new slice; an event change is a **new version** |
| Rename a command, event or read model | Rename | **Replace:** a new slice with the new name; delete the old one | **Supersede:** a new slice; deprecate the old endpoint |
| Remove a slice | Remove it | **Delete** it, its code, and its event if nothing else produces or reads it; reset the local database | **Never delete events.** Deprecate the endpoint, then remove it once clients have moved |
| Change an event's fields | Edit it | Edit it, if nothing *released* holds it; re-plan every slice that holds it | **A new version** (`…V2`, `schemaVersion`, `versionedHandler`), even for an optional field (ADR-018) |
| Change an event's tags (its id fields) | Edit it | Check who uses the tag (below); then one commit to `Events.ts`, and a same-name replacement of each slice whose tests check the old tags | **A new version**: a stored event keeps its tags (ADR-048) |
| Retire an automation | Remove it | Delete it and its code | **Switch it off** when its successor goes in (two would both act); its to-do list carries the open items over (ADR-039) |
| Split or merge slices | Reshape | New slices; delete the old ones | New slices; supersede the old ones |
| A read model's projection | Edit it | An extension slice (ADR-019) | An extension slice; it keeps handling old events and old versions |

**A built slice is never amended in place** (ADR-046). emcli's export holds back a built slice whose model
changed, so an edit to one never reaches the loop. Replace it instead.

### A change other slices use (expand, switch, contract)
First find what else uses the thing you're changing: `grep -rl "slices/<folder>/" src/contexts`. Typically that's
an automation importing the command it issues, or a slice importing an event's type.

- **If nothing else uses it,** or the change leaves what they use as it was (only a rule changes, say), replace the
  slice as below.
- **If the change alters what they use** (a command's fields or name), a replacement in place breaks them. The loop
  may not edit them (`job-scope`), so it blocks. Instead:
  1. **Expand:** add the new slice with a **new name** for its command (and so its endpoint). The old one stays,
     so its users still build.
  2. **Switch:** replace each user with a slice that uses the new command (the same-name replacement below, for
     that slice).
  3. **Contract:** once nothing imports the old slice, delete it (before release), or deprecate it (after).

  Every step builds on its own, and no built slice is edited.

*Example:* "assign organisation owner" dropped `roleId` from `assignOwnerRole` but kept the name. "Owner on
activation" issues that command, so it broke, and the loop edited it (licensing `1fc4905`, the one exception kept).
The plan should have been: add `assignOrganisationOwner`, replace "owner on activation" to issue it, then delete the
old slice.

### Changing an event's tags (ADR-048)
An event's tags are its id fields (`emcli element field set … --id`). An event recorded from another system also
carries that system's ids (Paddle: `paddleEventId`, `subscriptionId`). A read finds an event with **any** of a query
item's tags; an append condition conflicts with one that has **all** of its tags. So first find who uses the tag:

```bash
grep -rn "<tagKey>" src/contexts --include=decisionModels.ts --include=readModel.ts   # tagFilter, key, lookups, query tags
```

| The change | Compatible when | Otherwise |
|---|---|---|
| **Add a tag** | No query uses the new key for the event's type. If one does, it now finds the event: a decision folds more, a projection files it under more documents. | Replace that slice too |
| **Remove a tag, rename its key or change its value** | Never: every query by the old tag stops finding the event | Expand (add the new tag), switch (replace each user), contract (remove the old one) |

Before release, the change to `Events.ts` is one commit outside the loop. The producer's integration test checks
the tags exactly, so it fails until the producer's same-name replacement is built. Reset the local database.

### Before release (replace)
- Delete the old slice with emcli. If its event is still needed, **move** it to the new slice
  (`emcli element move`), so its copies stay linked.
- **Replacing a slice with one of the same name** (the usual case when only its definition changes, and nothing
  else uses what changes: see above):
  - add the new slice under a temporary name;
  - move the command and the event into it (`emcli element move`), and its scenarios (`emcli spec move … --to`),
    so their ids, links and copies stay;
  - remove the old slice, then rename the new one to the old name.

  The new slice is built into the **same folder**, over the old code. emcli's export queues it as a **rebuild**
  (`rebuild.changes`: "replaces the built slice in this folder", then what changed, links included), so the job
  updates that code rather than taking it as built. Put every change in the model, descriptions included: for an
  automation, the description and its links are all the job has to go on. Leave that code in place: other slices may
  import it (an automation imports the decider of the command it issues), and deleting it first breaks the build.
  emcli doesn't warn when you remove a built slice, so check `.build-kit/.slices` yourself.
- **Replacing it with a slice of another name:** remove the old slice's code by hand, its folder and its lines in
  `src/index.ts`, once nothing imports it (`grep -rl "<folder>/" src`). The loop has no job for this yet.
- **A full push** (`emcli sync push`, which deletes) recreates on the board an element moved out of a deleted slice,
  since the board deletes a slice's elements with it. Show the user the diff first.
- Reset the local database, since its events were only ever development data.
- `Events.ts` only grows in slice commits (the `events-append-only` check). A deliberate pre-release change to an
  event is its own commit, made outside the loop, and it says why.

### After release (supersede)
- The new slice has **its own endpoint**. Mark the old one deprecated in the contract, and remove it once its
  clients have moved.
- An event change is a new version. Every consumer of the event handles both versions.
- Old events stay in the store, and are still projected.

## 3. Keep slices independent

- **Each slice holds its own rules.** If two slices need the same rule, write it in both: duplication is the
  price of independence. Never make one slice call into another's code.
- **Own command or not** is a judgement for each case. Two slices that `produce` the same event from one command
  is the sign to look (emcli `completeness` warns about it). Give one its own command, or keep the rules in one
  slice.
- **A value the command always sets** (the owner command records the owner role) is a **generated** field mapped
  `derived:"<value>"`. Otherwise the contract puts it in the request body, and a caller could send another value.
- **A repeat is "nothing happens", not a rejection** (ADR-050). When the command's intent already holds (the same
  request again, a change already recorded by another route), its scenario's `then` is **nothing happens**
  (`emcli spec step add … then nothing "Nothing happens"`, never an empty `then`) and its title says why
  ("…: nothing happens"): the decider returns `[]` and the route answers 200. A rejection (`then` an error) is
  only for an intent that can't hold. Keep an event for a repeat only when something needs it (a notification's
  `paddleNotificationSkipped` "already done" closes its to-do item).
- **A call to another system: its reply is the fact** (ADR-049). A chapter modelled before it, with the other
  system's event as the step that leads to our fact ("paddle subscription updated" → `seatsWereAdded`), is reshaped
  when it's planned: the automation's reply issues our command, and the other system's event is a "skipped, already
  done" scenario. The `event-model` skill's method, "Asking another system to change something", has the shape.
- **An automation's data input that can arrive after its trigger** (the owner, after the trial) is a trigger too
  (ADR-051): link its event `reacts-to` the automation, and say in the description that the item waits without it.
  An automation built before ADR-051 that throws for it is replaced (a same-name replacement before release).
- **A read-model test depends on events, not on other slices.** Its *given* goes in with `app.given(...)`
  (`build-state-view` Step 6), never through another slice's route.
- **What the change touches:** every slice that produces or reads the same event, and every automation that
  issues the same command. Each is re-planned under the table above, by its own status.

## 4. Check the guards before you plan

Plan around what will refuse you, not into it:

| Guard | Refuses or holds back |
|---|---|
| emcli `element remove` / `slice remove` | Removing a released event (refused); removing anything built (a warning: its code goes too) |
| emcli `workspace export` | A built slice whose model changed (held back, not queued) |
| emcli `completeness` | One command producing an event in two slices; an event feeding a read model without its key as an id (warnings) |
| `events-append-only` check | A slice commit that removes or changes a line in `Events.ts` |
| `slice-scope` check | A slice commit touching another slice's folder (an extension slice may touch its origin) |
| `job-scope` check | The loop's job changing any slice but its own (or an extension's origin), committed or not: it blocks instead |
| `api-contract` check | The code's API not matching `api/openapi.json` |

## 5. When the table doesn't cover it

Stop, describe the case to the user, and give your recommendation. When they decide, record it as a Proposed
ADR in the kit repo's `eventmodelers-cli/stacks/dcb/ADR.md`, and add the rule here in the same PR.

## 6. Report the plan

Before running anything, say in a few lines:
- the status of everything the change touches;
- what is added, deleted, deprecated or versioned;
- what code goes, and whether the local database is reset;
- which slices are re-planned.

Ask before any board push that deletes, and before an export.

## The ADRs behind it

The full text is in the kit repo (`eventmodelers-cli/stacks/dcb/ADR.md`):

| ADR | Rule |
|---|---|
| 017 | `Events.ts` is append-only; event shapes are frozen once released. |
| 018 | An event changes by an explicit new version, for every change once released, breaking or not. |
| 019 | A read model grows through extension slices that edit the origin projection. |
| 020 | A projection rebuilds itself when its `canHandle` or `version` changes. |
| 022 | A read model's type (async, inline, live) is switchable; its tests are the same for every type. |
| 025 | API routes are named after the model, 1:1: a new command is a new route. |
| 029 | The API contract comes from the model (`api/openapi.json`). |
| 038 | One flow per chapter; an event has the same fields in every chapter. |
| 039 | An automation has a trigger, a to-do list and data inputs. |
| 046 | Replace a slice before release, supersede it after; released = `deployed`. |
| 048 | An event's tags are its id fields; a tag change follows the compatibility rules, by who queries the tag. |
| 049 | A decisive answer to our own call is recorded at once; the same change is recognised by its version. |
| 050 | A command whose intent already holds decides nothing (`[]`, 200); a rejection only when it can't hold. |
