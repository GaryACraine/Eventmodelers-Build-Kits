# Case study: automations as to-do lists

> The blueprint behind ADR-031 (PLAN Phase 15), written without code. The worked example is the payment request
> in the restaurant order domain (fraktalio's order-management demo, rebuilt with our method).

## The problem

Most of an event-sourced system is people doing things through screens. But some steps have no person behind
them: when an order needs paying, the system itself has to ask the payment gateway. Event modeling calls that step
an **automation**. It's one of its three core patterns, next to a state change (a command and its events) and a
state view (a read model).

An automation is harder than the other two, because:
- **nobody is waiting on it**, so no screen reports that it failed;
- **it often talks to a system we don't control**, which can be slow, down, or answer twice;
- **it must not do the work twice**, and it must not quietly skip it either.

## The blueprint in one picture

```
  opening event          to-do list                automation              command            closing event
 ┌──────────────┐     ┌───────────────────┐     ┌─────────────────┐     ┌─────────────┐     ┌─────────────┐
 │  Payment     │ ──► │ Payments awaiting │ ──► │ Payment         │ ──► │ (the work)  │ ──► │ Order Paid  │
 │  Initiated   │     │  order 42  open   │     │ Requester       │     │             │     │  or Payment │
 └──────────────┘     └───────────────────┘     └─────────────────┘     └─────────────┘     │  Failed     │
                                ▲                                                          └──────┬──────┘
                                └──────────────── ticks the item off ─────────────────────────────┘
```

- **An event puts an item on a list.** When `placeOrder` records *Payment Initiated*, order 42 goes on the
  *payments awaiting* list. That's all the event does.
- **The automation works from the list.** It acts on open items, never on the event directly.
- **The outcome is an event, and it ticks the item off.** *Order Paid* or *Payment Failed* closes the item.
- **Anyone can see what's pending.** The list is an ordinary read model: it's on the board, and a screen can show
  it.

The to-do list isn't infrastructure. It's part of the model, drawn between the event and the automation, just as
Dilger draws it (*Understanding Eventsourcing*, ch. 35).

## How the automation always finds its item

This is the part that's easy to get wrong. The to-do list and the automation both care about the same event.
If they run separately, the automation can arrive before the list has recorded the item, and find nothing.

The answer is the one Axon uses for its **processing groups**: put both in **one processor** and run them **in a
fixed order** for each event.

```
  one processor, for each event, in one save:
    step 1  the list:        add or tick off the item
    step 2  the automation:  is the item open? then act on it
    then    the processor records how far it has got
```

- **Step 2 can't miss the item,** because step 1 wrote it a moment before, in the same save.
- **Nothing signals between separate parts,** so there's nothing to lose or race.
- **Our library already works this way:** a processor handles one event at a time, in order, each in its own
  save. The kit only fixes the order of the two steps.

## Where Temporal comes in

Asking the payment gateway is **external work**: it goes to a system we don't control. For that, step 2 doesn't
make the call itself. **It hands the item to a Temporal workflow.**

- **The workflow is named after the item** ("payment request for order 42"). Handing over the same item twice
  does nothing, because Temporal already has a workflow with that name.
- **The workflow makes the call.** When the call fails, Temporal tries again, waits longer each time, and gives
  up after a limit. **All of that is Temporal's configuration.** We write no retry code.
- **Temporal keeps only the progress of the call.** Every business fact is still an event in our event store.
- **Handing over is quick,** so the processor never waits on the gateway.

Work that stays inside our system, an **internal** automation (an event that leads to one of our own commands),
doesn't need Temporal. Step 2 issues the command itself.

## What happens when…

| Situation | What happens |
|---|---|
| **The gateway is down** | Temporal keeps retrying on its schedule. Order 42 stays open on the list. When the gateway comes back, the call goes through. |
| **The gateway declines the payment** | That's an answer, not a failure: it comes back as *Payment Failed*, which closes the item. |
| **The gateway answers twice** | The answer becomes a command that carries the order's key, so the second one changes nothing. |
| **Temporal gives up** (retries exhausted) | The item stays open on the list, and Temporal's UI shows why. A person redrives it from the UI (PLAN 15.4, still to design). |
| **Temporal itself is down** | Step 2 can't hand the item over. The processor stops at that event, waits, and tries again. It shows it's blocked; it doesn't skip. Other processors carry on. This is Axon's default ("fail fast"). |
| **Our process crashes mid-way** | The save for that event never completed, so the processor handles the event again on restart. Step 1 finds the item already there, and the hand-over or command is recognised as a repeat. |
| **History is replayed** (a read model rebuilt) | Only step 1 runs, so the list is rebuilt and no work is repeated. Items still open stay open. |
| **A bug in our own handler** | Same as Temporal being down: the processor blocks on that event and shows the error, until the bug is fixed. Nothing is skipped silently. |

## One gap to decide in the model

The domain has no event saying "payment requested". So the list can't tell *not asked yet* from *asked, awaiting
the answer*. Temporal's workflow name covers most of this, since the same request is never sent twice while
Temporal remembers it. The model should still say it. The modeling step (PLAN 15.1) raises it as a hotspot rather
than inventing an event.

## How it compares

| | What it does | What we take, and what we change |
|---|---|---|
| **Axon 5 processing groups** | Runs a group's handlers one after another per event, in one save. It fails fast by default: it blocks and retries the event. Axon 5 has no dead-letter queue yet. | We take the grouping and fail fast. Our order is declared, where Axon's is implied by registration. |
| **Emmett reactors** | A throw stops the processor, and it resumes from the same point next run. A handler can `skip` or `stop`. Its advice is never to throw, and to record a failure event instead. | We take failure events and an opt-in skip. We don't let a processor die silently, which ours does today (PLAN 15.2 fixes it). |
| **Emmett workflows** | Event-sourced process managers with an inbox and an outbox. A failed outside call stops them, with no retries. | Nothing to take for outside calls. That's why Temporal does them. |
| **The reference (Cloudflare Workflow)** | The screen starts a workflow that places the order, waits up to an hour for the gateway, and then marks it paid or failed. Its progress lives in Cloudflare's store. | We take retries as configuration and one fixed key per step. We change where the truth lives: pending work is a list in the model, not state in an engine, and it runs in containers (ADR-030). |
| **Gary's Axon 5 example** (`addssndata`) | Groups the to-do projection and the automation, but the automation reacts to the event, never reads the list, and skips replays. | We take the grouping. We change the rest: the automation reads the list, failures are visible, and work goes through Temporal. |

## Why this works

- **One source of truth.** Everything that happened, and everything still to do, comes from events.
- **Nothing is invisible.** Pending and stuck work sits on a list that people can see.
- **Nothing is done twice.** Every piece of work carries its item's key.
- **Nothing is skipped quietly.** A failure either retries (Temporal) or blocks visibly (the processor).
- **It's idiomatic.** It's the book's pattern and Axon's grouping, built from what our library already has, plus
  one proven engine for the one thing none of them does: durable retries of calls to the outside.

## Sources

- Martin Dilger, *Understanding Eventsourcing*, ch. 35 "Processor-TODO-List" and ch. 26 "Implementing
  Automations".
- Axon Framework 5.0.2 and 5.1.0 (`ProcessorEventHandlingComponents`, `PropagatingErrorHandler`).
- Emmett guides: *Error Handling* and *Workflows & Sagas*.
- fraktalio, [order-management-demo-tanstack](https://github.com/fraktalio/order-management-demo-tanstack).
- `generator-axon5-scratch`, slice `addssndata`.
- Decisions: ADR-030 and ADR-031 (`eventmodelers-cli/stacks/dcb/ADR.md`).
