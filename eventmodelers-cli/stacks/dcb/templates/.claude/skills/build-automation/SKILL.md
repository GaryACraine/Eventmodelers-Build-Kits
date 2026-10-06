---
name: build-automation
description: Implements a DCB automation slice (event-driven, keeping a to-do list or none; internal work issues our command, external work runs in a Temporal workflow) from a slice.json definition
---

# Build Automation Slice (DCB)

> Before doing anything else, read the slice definition from `.build-kit/.slices/{Context}/{slicename}/slice.json`. It
> is the **source of truth** for fields, events, commands and rules. Never invent a field or a rule that isn't there.

## What an automation is (ADR-031, ADR-033)

An automation is work the system does with nobody at a screen. The model draws it as:

```
opening event → to-do list (a read model) → automation → command → closing event (ticks the item off)
```

In code it is **one processor**, the to-do list's own, which runs two steps for each event:

1. **the list step**: the to-do list's projection opens or closes the item;
2. **the automation step**, for a trigger event: if the item is open *as it stands now*, `act`.

The kit's helper (`src/shared/automations.ts`) does both steps, the idempotency keys, replays and rebuilds. **You
write only `act`**, plus, for external work, a Temporal workflow and its activities.

| | Internal | External |
|---|---|---|
| What | our event → **our** command | our event → a system we don't control (a payment gateway, a carrier) |
| `act` | `issue(decider, command)` | `start("<workflowType>", [input])` |
| Where the work runs | in the processor | in a Temporal workflow (`workflow.ts`, `activities.ts`) |
| Retries | the processor retries the event (fail fast) | Temporal retries, by the workflow's configuration only |

**This skill is general.** What's true of one outside system (its SDK, which answers mean what, its error codes, its
test values, its quirks) is in that system's **provider skill**, `.claude/skills/provider-<system>/SKILL.md` (e.g.
`provider-braintree`). Changing provider changes that skill, not this one.

Never catch an error in `act` or an activity to "log and carry on". A thrown error in `act` blocks the
processor on that event, retries it with backoff and shows it on `GET /health/processors`. A thrown activity error is
retried by Temporal. Swallowing either loses the work silently.

---

## Step 1: Read the slice.json

- `processors[0]` is the automation:
  - `processorType`: `event-driven` is this skill, keeping a to-do list or none (below). `polling` runs on a
    `schedule` with no trigger: "Timed work" below, a **draft on first use**. `synchronous`
    (deciding inside the webhook request) is superseded by ADR-040: block the job, saying the model should record
    the notification and translate it with an event-driven automation ("A translation" below).
  - `dependencies` (ADR-039, "what flows into an automation"):
    - `INBOUND reacts-to EVENT`: the **triggers**;
    - `INBOUND relates-to READMODEL` whose read model has **`todoListElement: true`**: the **to-do list** (exactly
      one; two is a model problem: block naming it). **None**: the automation keeps no to-do list, and the trigger
      event is the item ("An automation with no to-do list" below). A **translation** of another system's recorded
      notifications keeps a to-do list ("A translation" below). An **external** automation with none is a model
      problem (a stall needs a list to be recorded on): block naming it;
    - every other `INBOUND relates-to READMODEL`: a **data input**, a read model whose values the command needs (it may
      be a list, or another chapter's). One with `context: EXTERNAL` and an `externalSystem` is an **outside system's
      data**: it makes the automation external (fetched in an activity, through that system's provider skill);
    - `OUTBOUND relates-to COMMAND`: the **commands** it leads to.
  - `description`: whether it's **internal** or **external**, the idempotency key (`stock-returner:<orderId>`), the
    workflow id (`payment-request:<orderId>:<attempt>`), **the outside system** (read its provider skill), what its
    answers mean, and any rulings. Follow it to the letter. An outside system with no provider skill: block the job
    asking for one.
- `events[]`: the trigger events with their fields (the data `act` gets).
- `specifications[]`: GIVEN/THEN scenarios, with no WHEN. THEN is the command it issues, or nothing.

The automation's **name** is the part before `:` in its idempotency key or workflow id (`stock-returner`,
`payment-request`).

**Names in code** are the project's, not the model's: a slice's folder is its `folder` in `index.json` (lowercase,
no hyphens: `stocktoreturn/`), and import what the list's `readModel.ts` and each command's `decider.ts` actually
export (`stockToReturn`, `returnStockDecider`). The examples below use the restaurant project's names.

## Step 2: Check what it needs is built

The loop builds an automation after the slices it needs, so these exist:

- **the to-do list**: `src/contexts/{context}/slices/{list-slice}/readModel.ts`, `type: "database-projected"`, keyed by
  the trigger's id field, and registered in `src/index.ts` `readModels`;
- **each data input** (our own): its `readModel.ts`, any type (it's read live, by key);
- **each command's decider**: `src/contexts/{context}/slices/{command-slice}/decider.ts`.

If one is missing, or the list isn't `database-projected`, block the job naming what's missing. Don't build it here:
one job builds one slice.

---

## Internal automation

### `processor.ts`

File: `src/contexts/{context}/slices/{slicename}/processor.ts`

```typescript
import { defineAutomation } from "../../../../shared/automations.js"
import { stockToReturn, type StockToReturnDoc } from "../stocktoreturn/readModel.js"
import { returnStockDecider } from "../returnstock/decider.js"

/**
 * Stock Returner (internal): the to-do list StockToReturn, opened by orderPaymentFailed, closed by stockReturned.
 * For each open item it issues returnStock, once: the idempotency key is stock-returner:<orderId>.
 */
export const stockReturner = defineAutomation<StockToReturnDoc>({
    name: "stock-returner",
    todoList: stockToReturn,
    triggers: ["orderPaymentFailed"],
    act: async ({ item, issue }) =>
        issue(returnStockDecider, {
            type: "returnStock",
            data: { orderId: item.orderId, restaurantId: item.restaurantId, menuItems: item.menuItems }
        })
})
```

- The command's data comes from `item` (the to-do list's document), `event` (the trigger), or a **data input** read
  with `read(readModel, key)`, as the command's field mappings in slice.json say (`stockDeducted.menuItems` → the list's
  `menuItems`; `OrganisationOwner.ownerUserId` → `(await read(organisationOwner, item.organisationId)).ownerUserId`).
  `read` folds the read model live from the event store, so it's current. If it returns null, throw: the processor
  retries the event until the data is there (never issue the command without it).
- `issue` gives the command the idempotency key `<name>:<item key>`. A repeat (a retry after a crash, the same event
  handled again) is recognised and not decided again.
- **An item worked again** (a payment declined, paid again, declined again: the stock goes back each time) passes the
  attempt its trigger belongs to: `issue(decider, command, { attempt })` keys it `<name>:<item key>:<attempt>`.
  Without it, the second attempt looks like a repeat of the first and is silently skipped. The trigger event carries
  the attempt when the model gives it one.

### Wiring (`src/index.ts`, committed separately: `chore: wire <Slice Name>`)

```typescript
import { stockReturner } from "./contexts/restaurant/slices/returnfailedorderstock/processor.js"

const automations: Automation[] = [stockReturner]
```

---

## External automation

The work is a call to a system we don't control, so it runs in a **Temporal workflow** named after the item. The
workflow calls the system in an activity, then records the answer as our command.

### The provider

Read the outside system's provider skill first: it gives the SDK and its setup from the environment, what each answer
and error means, how to never do the work twice, and the mock. Use the provider's **official SDK**, the one
production will use. `package.json` can't change in a slice commit (blocked-paths): if the SDK isn't installed, block
the job, asking for it (`npm install <sdk>`) to be added.

### `workflow.ts`: deterministic, no I/O

```typescript
import { ActivityFailure, ApplicationFailure, TimeoutFailure, proxyActivities } from "@temporalio/workflow"
import type { PaymentRequestActivities } from "./activities.js"

export interface PaymentRequestInput {
    orderId: string
    attempt: number
    amount: string
    paymentMethodNonce: string
}

// The outside call: retries, backoff and timeouts are configuration, bounded (about 5 minutes), no loops of our own
const { chargeCard } = proxyActivities<PaymentRequestActivities>({
    startToCloseTimeout: "30 seconds",
    retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "1 minute", maximumAttempts: 10 }
})
// Recording in our own store: retried until it succeeds (our database back is the only fix). A command our rules
// refuse (the order already paid) is an answer, not an outage: never retried
const { recordPaid, recordFailed, recordStalled } = proxyActivities<PaymentRequestActivities>({
    startToCloseTimeout: "30 seconds",
    retry: {
        initialInterval: "1 second",
        backoffCoefficient: 2,
        maximumInterval: "1 minute",
        nonRetryableErrorTypes: ["IllegalStateError", "NotFoundError", "ValidationError"]
    }
})

export async function paymentRequest(input: PaymentRequestInput): Promise<void> {
    let answer
    try {
        answer = await chargeCard(input)
    } catch (err) {
        // Temporal gave up: the outcome is unknown. Record a stall, never a decline (ADR-032)
        await recordStalled(input.orderId, input.attempt, stallOf(err))
        return
    }
    if (answer.outcome === "paid") await recordPaid(input.orderId, input.attempt)
    else await recordFailed(input.orderId, input.attempt, answer)
}

/** configuration: a non-retryable failure of that type; unavailable: retryable ones ran out, or timed out; else unknown */
function stallOf(err: unknown): { category: "configuration" | "unavailable" | "unknown"; error: string } {
    const cause = err instanceof ActivityFailure ? err.cause : err
    const error = cause instanceof Error ? cause.message : String(cause)
    if (cause instanceof ApplicationFailure && (cause.type === "configuration" || cause.type === "unavailable"))
        return { category: cause.type, error }
    if (cause instanceof TimeoutFailure) return { category: "unavailable", error }
    return { category: "unknown", error }
}
```

The workflow runs in Temporal's sandbox and is replayed from its history:
- **no I/O, clocks, random numbers or imports of our code** (only `import type`);
- inputs and results are plain JSON;
- **business state stays in our events**: the workflow calls, then records the answer as a command, and never keeps
  the answer to itself. It doesn't wait for a later answer either: one that arrives later comes in through a webhook
  and a command, not a signal the workflow waits for.
- **catching the outside call's final failure is the one catch allowed**, and it must record the stall: that turns
  "Temporal gave up" into a business fact a person can act on (retry or give up), instead of an item that looks in
  progress forever.

### `activities.ts`: the calls

```typescript
import type { EventStore } from "@dcb-es/event-store"
import type { Pool } from "pg"
import { issueOnce } from "../../../../shared/automations.js"
import { alert as defaultAlert, type Alert } from "../../../../shared/alerts.js"
import { markOrderPaidDecider } from "../markorderpaid/decider.js"
import { markOrderPaymentFailedDecider } from "../markorderpaymentfailed/decider.js"
import { markPaymentStalledDecider } from "../markpaymentstalled/decider.js"

// The business answer and its details: the provider skill says how each of the provider's answers maps to them
export type ChargeAnswer =
    | { outcome: "paid" }
    | { outcome: "declined"; reason: string; kind: string; code?: string; card?: string }

export function paymentRequestActivities(deps: { eventStore: EventStore; pool: Pool; gateway: Gateway; alert?: (a: Alert) => void }) {
    const alert = deps.alert ?? defaultAlert
    return {
        async chargeCard(input: PaymentRequestInput): Promise<ChargeAnswer> { /* the provider skill's call and reading */ },
        recordPaid: (orderId: string, attempt: number) =>
            issueOnce(deps, `payment-result:${orderId}:${attempt}`, markOrderPaidDecider, { type: "markOrderPaid", data: { orderId } }),
        recordFailed: (orderId: string, attempt: number, answer: Extract<ChargeAnswer, { outcome: "declined" }>) =>
            issueOnce(deps, `payment-result:${orderId}:${attempt}`, markOrderPaymentFailedDecider, {
                type: "markOrderPaymentFailed",
                data: { orderId, attempt, reason: answer.reason, kind: answer.kind, code: answer.code, card: answer.card }
            }),
        async recordStalled(orderId: string, attempt: number, stall: { category: string; error: string }) {
            await issueOnce(deps, `payment-stalled:${orderId}:${attempt}`, markPaymentStalledDecider, {
                type: "markPaymentStalled",
                data: { orderId, attempt, ...stall }
            })
            alert({
                code: "payment-stalled",
                severity: stall.category === "configuration" ? "critical" : "warning",
                message: `The payment of order ${orderId} (attempt ${attempt}) stalled: ${stall.error}`,
                details: { orderId, attempt, ...stall }
            })
        }
    }
}
export type PaymentRequestActivities = ReturnType<typeof paymentRequestActivities>
```

- **A business answer is a result, a technical failure is thrown**, and each is classified by the provider skill:
  - a decline (a refused card, an unknown address) is **returned**, with a `kind` (what the user can do about it) and
    the provider's `code`, and the workflow records it with our command;
  - a failure a retry can fix (network, busy, down) is thrown as `ApplicationFailure.retryable(message,
    "unavailable")` (or as it is), so Temporal retries it;
  - a failure no retry can fix (keys refused, not permitted, an SDK too old) is thrown as
    `ApplicationFailure.nonRetryable(message, "configuration")`: the workflow stalls at once, and the administrator is
    alerted as critical. When the provider can report such a failure spuriously, the skill says how many attempts
    first;
  - anything unclassified is thrown as it is (a stall after the retries is `unknown`).
- **Never do the outside work twice.** Pass our key as the provider's idempotency key if it has one. If it has none,
  the provider skill says what to combine instead (typically: look for an earlier attempt by our reference before
  calling again, and treat a "duplicate" or "already used" rejection as "look again", bounded by the attempt
  (Temporal's `Context.current().info.attempt`, injectable so tests can set it)).
- **Keys per attempt:** the answer's idempotency key is `<result>:<item key>:<attempt>`, and the stall's
  `<stalled>:<item key>:<attempt>`, so a later attempt records its own answer.
- **Config comes from the environment**, with defaults that point at the mock (`localhost:<its port>`), so the
  provider's sandbox or production is a config change. **Our deadline per call**, below the activity's
  `startToCloseTimeout`, never the SDK's default.

### `processor.ts`

```typescript
import { defineAutomation } from "../../../../shared/automations.js"
import { paymentsAwaiting, type PaymentsAwaitingDoc } from "../paymentsawaiting/readModel.js"
import type { PaymentRequestInput } from "./workflow.js"

/** Payment Requester (external): one workflow per payment attempt, payment-request:<orderId>:<attempt>. */
export const paymentRequester = defineAutomation<PaymentsAwaitingDoc>({
    name: "payment-request",
    todoList: paymentsAwaiting,
    triggers: ["paymentInitiated"],
    act: async ({ event, start }) => {
        const data = event.event.data as PaymentRequestInput
        const input: PaymentRequestInput = {
            orderId: data.orderId,
            attempt: data.attempt,
            amount: data.amount,
            paymentMethodNonce: data.paymentMethodNonce
        }
        await start("paymentRequest", [input], { attempt: data.attempt })
    }
})
```

`start` names the workflow `<name>:<item key>:<attempt>`. Temporal runs it once: a repeated start joins it or, once
it has finished, does nothing. A later attempt (a retry after a stall, the customer paying again) is a new id.

### Registering it

- `src/workflows.ts`: add **one line** (in the slice commit; the file only grows):
  `export { paymentRequest } from "./contexts/restaurant/slices/requestpayment/workflow.js"`
- `src/index.ts` (the wiring commit): add the automation to `automations`, and its activities to `activities`:
  ```typescript
  const activities = {
      ...paymentRequestActivities({ eventStore, pool, gateway: braintreeGateway() })   // the provider skill's gateway
  }
  ```

### The mock of the outside system

Every outside system runs as a container locally and in tests (ADR-030). If `mocks/{system}/` doesn't exist, build it
in this job:

- **Follow the provider's published API**, only the endpoints our SDK calls. Read the SDK's request and response code
  in `node_modules` for the exact paths, formats (JSON or XML) and fields.
- **Answer as the provider's sandbox does**, with the test values, rules and codes its provider skill lists, so the
  model's scenarios run against it unchanged.
- **Reach every failure**: switches for the errors the provider skill classifies (busy, down, keys refused), so the
  tests can prove each retry and each stall.
- **Keep what it was asked**, so a test can check nothing was charged twice.
- **Files:** `mocks/{system}/server.ts` (Node's `http`, no dependencies, erasable TypeScript only, so `node server.ts`
  runs it; export a `startMock(port)` for tests) and a `Dockerfile` (`FROM node:24-alpine`, `CMD ["node",
  "server.ts"]`), plus a service in `docker-compose.yml` publishing its port. Tests listen on 127.0.0.1; run as
  `node server.ts` it listens on `HOST`, default `0.0.0.0`, or the container's published port reaches nothing.

---

## A translation: another system's notifications (ADR-040)

Another system's webhook becomes our event in two steps. A thin endpoint records the notification as it arrived
(`src/shared/inbox.ts`: signature checked, one event such as `carrierNotificationReceived`, de-duplicated by the
notification's id, then 200). The **translation** is the automation that works those recorded notifications
afterwards: the recorded notification → its to-do list → the automation → our command → our event.

It is an ordinary internal automation **with a to-do list**: a notification is on the list from the moment it's
recorded until it has an outcome. The list's key is the notification's id, so every event the commands record
carries that id as a tag (it's a field of each of them in slice.json).

```typescript
import { defineAutomation } from "../../../../shared/automations.js"
import { notificationsToTranslate, type NotificationsToTranslateDoc } from "../notificationstotranslate/readModel.js"
import { recordDeliveryDecider } from "../recorddelivery/decider.js"
import { skipCarrierNotificationDecider } from "../skipcarriernotification/decider.js"
import { parcelStatus } from "../parcelstatus/readModel.js"

/**
 * Carrier Translation (internal): the to-do list NotificationsToTranslate, opened by carrierNotificationReceived,
 * closed by the outcome. One outcome per notification, under the key carrier-translation:<notificationId>.
 */
export const carrierTranslation = defineAutomation<NotificationsToTranslateDoc>({
    name: "carrier-translation",
    todoList: notificationsToTranslate,
    triggers: ["carrierNotificationReceived"],
    act: async ({ item, read, issue }) => {
        // Classify by the other system's type plus our own state, as the description says
        if (item.status !== "delivered") throw new Error(`carrier status ${item.status} has no translation`)
        const parcel = await read(parcelStatus, item.parcelId)
        if (!parcel) throw new Error(`no parcel ${item.parcelId} yet`)
        await issue(recordDeliveryDecider, {
            type: "recordDelivery",
            data: { parcelId: item.parcelId, notificationId: item.notificationId, occurredAt: item.occurredAt }
        })
    },
    giveUp: {
        after: 5,
        record: ({ key, issue }, error) =>
            issue(skipCarrierNotificationDecider, {
                type: "skipCarrierNotification",
                data: { notificationId: key, reason: "failed", error: error instanceof Error ? error.message : String(error) }
            })
    }
})
```

- **One outcome per notification.** `issue` keys the command `<name>:<notification id>`, and the processor only
  works an item that is still open, so a notification worked again (a restart, a redelivery that slipped through)
  changes nothing.
- **Classify from the other system's type plus our own state** (`read` a data input), as the description says: the
  same type can mean different things (a subscription "activated" is a trial converting, or a payment recovering).
  The provider skill says what each type carries.
- **Order and repeats are the command's decider's job, not `act`'s.** The decider compares the notification's
  `occurredAt` with the last one it applied for that entity and records the notification as **skipped** (`stale`),
  or as `already done` when the same fact arrived by another route; otherwise it records our event. It decides under
  the append condition, so there's no race. `act` never reads a stored row to decide that.
- **A type the description doesn't list is an error**: throw. Don't drop it silently.
- **`giveUp`** (any automation can have one; a translation always does): after `after` failed attempts on one item,
  `record` issues the model's skip command with `reason: "failed"` and the error, the kit alerts the administrator
  (`automation-gave-up`), and the processor moves on to the items behind it. Use the number the description gives (5
  if it gives none). Without `giveUp`, a failing item blocks the ones behind it until it succeeds.
- **The to-do list keeps a failed item**, as its slice.json says: a skip with `reason: "failed"` marks the item
  (`state: "failed"`, with the error) and leaves it listed; any other outcome (our event, or a skip that is `stale`
  or `already done`) removes it. That's the list's `readModel.ts`, built by its own slice.
- **Tests** are GIVEN/THEN through `automationTestApp`, with the recorded notification as the GIVEN. Add the cases
  every translation needs, from the provider skill's saved payloads: the same notification twice, two notifications
  in the wrong order, and one that can't be translated (`app.alerts()` has the alert, and the list still holds the
  item as failed; pass `backoff: { initialMs: 10 }` so the attempts don't take seconds).

The endpoint that records the notification is its own slice, an **external event** (below).

## An external event: the endpoint that records it (ADR-045): a draft, on first use

> **Draft.** Proven by the kit's inbox tests and Paddle's real webhooks through a tunnel
> (`licensing/e2e/paddle/`), not yet by a slice the loop built. Where a slice doesn't fit, block the job with
> `request-feedback` saying what didn't fit.

`sliceType: "EXTERNAL_EVENT"`: the slice holds one event that **another system tells us** (its `context` is
`EXTERNAL`, `externalSystem` names the system, e.g. `Paddle`), and nothing else of ours: no command, no decider, no
route of its own. Its fields are mapped `webhook:<path in the payload>`. Building the slice means building the door
that event comes in by: the webhook endpoint of ADR-040, recording the event as it arrived and answering at once.
What we do with it is the translation, built by other slices.

Read the system's provider skill first (`provider-paddle`): it has the system's signature check, the reader that
turns a payload into this event (`toEvent`), the endpoint's path, the saved payloads and the mock.

**Files:**

```
src/providers/<system>/<system>.ts     the provider skill's module, if no slice has created it yet (shared)
src/contexts/<ctx>/slices/<slice>/inbox.ts          the endpoint's inbox for this event
src/contexts/<ctx>/slices/<slice>/inbox.tests.ts    its tests
src/contexts/<ctx>/Events.ts           the event added to the context's union (append-only), as for any event
```

```typescript
// inbox.ts: the door paddleNotificationReceived comes in by (Paddle's webhook, ADR-040)
import { paddleConfig, paddleInbox } from "../../../../providers/paddle/paddle.js"

export const paddleNotificationInbox = paddleInbox(paddleConfig())
```

- **The event's fields are exactly slice.json's:** the provider's `toEvent` must produce every field the slice
  lists, with its name and type, and no others. Where they differ, the model wins: change the reader, or block the
  job if the provider skill disagrees with the model.
- **Wiring** (`chore: wire <Slice Name>`, in `src/index.ts`): `configureWebhookInbox({ eventStore }, <inbox>)` in
  `apis`, after `configureJsonBody()` (the scaffold has it: the signature is checked against the raw body).
- **Tests** (`inbox.tests.ts`), through the app with the kit's JSON parser, from the provider skill's **saved real
  payloads** (never one written from memory), signed the way the system signs:
  - a signed payload answers 200 and records the event with slice.json's fields, tagged as the slice says;
  - the same notification again answers 200 and records nothing more;
  - a wrong or missing signature answers 401 and records nothing;
  - a signed payload that can't be read answers 400, records nothing, and alerts (`inbox-unreadable`).
- **A copy of the event in another chapter** shows the same fact; only the original's slice is
  `EXTERNAL_EVENT`, so the endpoint is built once.

## An automation with no to-do list

An event-driven automation may keep no to-do list: **the trigger event is the item**, and the work is done at once
from that one event, once per key. `defineAutomation` takes a `key` instead of a `todoList`: the tag that holds
**the trigger event's own id** (its id field in slice.json). `item` is the trigger event's data. There's no list
read model to import or register; the automation has a processor and a checkpoint of its own, named after it.

```typescript
export const receiptSender = defineAutomation<ReceiptRequestedData>({
    name: "receipt-sender",
    key: "receiptRequestId",
    triggers: ["receiptRequested"],
    act: async ({ item, issue }) => issue(sendReceiptDecider, { type: "sendReceipt", data: { receiptRequestId: item.receiptRequestId } })
})
```

- **The key identifies the trigger event itself**, not an entity (`organisationId`). Keyed by an entity's id, the
  work is done once per entity, ever, and a second event for it is silently skipped. If the trigger's id field is
  an entity's and the description doesn't say that once per entity is meant, block the job asking.
- Nothing shows the work waiting, and an **external** automation with no list can't record a stall: that's a model
  problem, block naming it.
- Tests: `automationTestApp({ readModels: [], automations: [receiptSender] })`.

## Timed work (ADR-042): a draft, on first use

> **Draft.** The kit's helpers are proven by their own tests (`src/shared/temporal.tests.ts`). These three shapes
> haven't been built from a slice yet. Follow them; where a slice doesn't fit, block the job with `request-feedback`
> saying what didn't fit, and don't improvise. What you learn goes in the project's lessons: this section is
> rewritten from them once the first slices and the end-to-end run pass.

Work started by time runs on Temporal, with one tool per need:

| The slice says | Shape | In code |
|---|---|---|
| `processorType: polling` with a `schedule` ("every 15 minutes") | a **Schedule** | `defineSchedule` |
| the automation's description: work **due at** a date the trigger carries (an expiry) | a **start with a delay** | `start(…, { dueAt })` |
| the description: **keep trying** for an outside fact until the item closes | a workflow with **timers** | `sleep` in `workflow.ts` |

### A polling automation: a Schedule

`schedule.ts`, in the slice's folder:

```typescript
import { defineSchedule } from "../../../../shared/automations.js"

/** Carrier Sync (polling): every 15 minutes, fetch the carrier's events after our checkpoint and record each. */
export const carrierSync = defineSchedule({
    name: "carrier-sync",
    every: "15 minutes",
    workflowType: "carrierSync",
    runAtStart: true
})
```

- `name` is the part before `:` in the description's id; `every` is the slice's `schedule`, as a number and a unit.
- `runAtStart: true` when the description says it also runs when the app starts.
- **Its workflow** (`workflow.ts`) calls activities, as an external automation's does: no I/O of its own.
- **Its activities are idempotent**: Temporal can run one again before the last attempt has finished. Record each
  outside fact under its id at the outside system (`issueOnce`, or the inbox's append), so a repeat adds nothing.
- **What it keeps between runs is an event of ours** (a checkpoint the slice names), read at the start of a run and
  recorded at the end. It only moves forward. Never Temporal's last completion result.
- **A failed run** is the workflow failing after its activities' retries: alert (`src/shared/alerts.ts`) and let it
  fail. The next run tries again; nothing is recorded as stalled.
- Don't set overlap, catch-up or pause policies: the kit sets them (a run still going means the next is skipped).
- **Wiring** (`src/index.ts`, the wiring commit): add it to `schedules`, its workflow to `src/workflows.ts`, its
  activities to `activities`.
- **"Run it now"** from elsewhere (a webhook's route): `scheduleWatch.trigger("carrier-sync")`, which
  `src/index.ts` holds and passes to what needs it (the wiring commit). A trigger during a run queues one more.
- **Tests:** the activities against the mock, as for an external automation; and the workflow started directly on
  the test server (`client.workflow.start("carrierSync", …)`), never by waiting for the timetable.

### Work due at a known time: a start with a delay

An event-driven, external automation whose trigger carries the date (an invitation's `expiresAt`). `act` starts the
workflow now, due then:

```typescript
act: async ({ item, start }) => start("expireInvitation", [item.invitationId], { dueAt: new Date(item.expiresAt) })
```

- One workflow per item, `<name>:<item key>`, as for any external automation.
- **When it wakes, it acts only if the item is still open**: its first activity reads the to-do list (or folds the
  item's events) and returns if it's closed (accepted, withdrawn). Then it records our command with `issueOnce`.
- Nothing cancels the workflow when the item closes early: waking to find it closed is the design.
- **Tests:** `app.started()` has the workflow with its `dueAt`; the activities, given an open and a closed item.

### Watching for an outside fact: timers in a workflow

An event-driven, external automation with a to-do list. Its workflow tries at the intervals the description gives,
and stops as soon as the item is closed:

```typescript
import { proxyActivities, sleep } from "@temporalio/workflow"

export async function checkoutWatch(organisationId: string): Promise<void> {
    for (const wait of ["2 seconds", "3 seconds", "10 seconds", "15 seconds", "30 seconds"]) {
        await sleep(wait)
        if (!(await isStillAwaited(organisationId))) return
        await fetchEvents()
    }
}
```

- The waits are the gaps between the description's times (2, 5, 15, 30, 60 seconds → 2, 3, 10, 15, 30).
- **Bounded:** it stops after the last try whatever happened. Something else (a webhook, the polling automation)
  brings the fact later. Nothing is recorded as stalled.
- A try that fails is the activity failing after its own short retries: catch it in the workflow only to carry on to
  the next wait (the one catch allowed here, as for a stall).
- **Tests:** the workflow on the test server with short waits and activities that close the item after a try or two.

---

## Stalls: when the outside system can't be reached (ADR-032)

An external item can end three ways: a **business answer** (the item closes), **our side blocked** (the processor
retries; a deploy or the dependency returning fixes it), or **stalled**: Temporal gave up with the outcome unknown.
Nothing runs on a timer, so a stall must be recorded, or the item looks in progress forever.

- The model gives the automation a **stall command** (e.g. `markPaymentStalled` → `paymentStalled`) with the item's key,
  the attempt, a **category** (`configuration`, `unavailable`, `unknown`) and the last error; the to-do list marks the
  item stalled. Its slice is a normal write slice, built before the automation.
- The workflow catches the outside call's final failure and records the stall (`workflow.ts` above). The recording
  activities retry without limit: only our own store can stop them.
- The stall-recording activity **alerts the administrator** (`src/shared/alerts.ts`): `critical` for
  `configuration`, else `warning`. Best-effort; the stalled item is the record.
- A person then **retries** (a command recording the next attempt's trigger, e.g. a new `paymentInitiated`) or **gives
  up** (a command recording the automation's failure outcome, kind `abandoned`). Both are ordinary write slices from
  the to-do list's screen; the automation needs nothing more for them.
- A workflow **terminated by hand** in Temporal's UI records no stall: say so in the manual; *give up* is the tool.

## `processor.tests.ts`: one test per specification

File: `src/contexts/{context}/slices/{slicename}/processor.tests.ts`. Specs are GIVEN/THEN. `automationTestApp`
starts the read models and automations as the app does, on a fresh database per test. It appends the GIVEN events in
**one** append, so the automation never sees part of the history.

**Internal:**

```typescript
import { describe, test, expect } from "vitest"
import { automationTestApp } from "@test/automationHarness"
import { orderPaymentFailed, stockDeducted, stockReturned } from "../../Events.js"
import { stockToReturn } from "../stocktoreturn/readModel.js"
import { stockReturner } from "./processor.js"

describe("return failed order stock", () => {
    const app = automationTestApp({ readModels: [stockToReturn], automations: [stockReturner] })

    test("returns the stock of an order whose payment failed", async () => {
        await app.given(stockDeducted({ … }), orderPaymentFailed({ … }))
        expect(await app.appended()).toEqual([{ type: "stockReturned", data: { … } }])
    })

    test("does nothing once the stock is returned", async () => {
        await app.given(stockDeducted({ … }), orderPaymentFailed({ … }), stockReturned({ … }))
        expect(await app.appended()).toEqual([])
    })
})
```

**External**, against Temporal's test server, a worker and the mock:

```typescript
let temporal: TemporalTestServer
let mock: { port: number; stop(): Promise<void> }
beforeAll(async () => { temporal = await startTemporalTestServer(); mock = await startMock(0) }, 120_000)
afterAll(async () => { await temporal?.stop(); await mock?.stop() })

describe("request payment", () => {
    const taskQueue = "request-payment-test"
    const app = automationTestApp({
        readModels: [paymentsAwaiting],
        automations: [paymentRequester],
        workflows: { start: (...args) => temporalWorkflowStarter(temporal.env.client, taskQueue).start(...args) }
    })
    const run = (fn: () => Promise<void>) =>
        withWorker(temporal, {
            taskQueue,
            workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
            activities: paymentRequestActivities({ eventStore: app.runtime().eventStore, pool: app.pool(), gateway: /* the mock */ })
        }, fn)

    test("charges the card and marks the order paid", () =>
        run(async () => {
            await app.given(paymentInitiated({ orderId: "o1", amount: "12.00", paymentMethodNonce: "fake-valid-nonce", attempt: 1 }))
            expect(await app.waitForAppended(1)).toEqual([{ type: "orderPaid", data: { orderId: "o1" } }])
        }))
})
```

- **THEN a command** → `appended()` (internal) or `waitForAppended(n)` (external: the workflow records it after the
  processor has moved on) equals that command's events. They appear only if the command's own rules accept it, so
  the GIVEN holds the history that command needs (the order placed, not only its payment initiated). If a spec's
  GIVEN lacks it, block the job: the model's scenario is incomplete, and saying so is the fix.
- **THEN nothing** → `appended()` is `[]`; for an external automation, `app.started()` with the default recorder is
  `[]` (no workflow was started).
- **The Temporal server lives for the whole file**, beyond each test's database, and a workflow id that has run
  can't run again. Give each test its own item keys (`o1`, `o2`, …).
- **External: also test the activity against the mock**: a repeated call for the same order charges once; each
  classified failure (the provider skill's table) is retried, stalls with its category, or declines with its kind.
- **External: a stall.** With the mock failing past the retries (shorten them in the test's workflow options, or use a
  non-retryable `configuration` failure), the stall command's events appear, and the alert was called (inject `alert`).

---

## Files

```
src/contexts/{context}/slices/{slicename}/
├── processor.ts          ← defineAutomation (every event-driven kind)
├── schedule.ts           ← polling: defineSchedule (draft, ADR-042)
├── workflow.ts           ← external: the Temporal workflow
├── activities.ts         ← external: the calls, and recording the answer as our command
└── processor.tests.ts    ← one test per specification
src/workflows.ts          ← external: one export line (append only)
src/index.ts              ← automations[] (+ activities), committed separately
mocks/{system}/           ← external: the provider's mock, if it doesn't exist yet
docker-compose.yml        ← the mock's service
```

## Checklist

- [ ] `defineAutomation` with the name from the description, the to-do list, and the `reacts-to` triggers
- [ ] A translation: a to-do list keyed by the notification's id, one outcome per notification, order and repeats
      left to the decider, `giveUp` recording the skip
- [ ] No to-do list: `key` is the trigger event's own id
- [ ] Timed work (draft): the shape matches the slice; activities idempotent; a polling automation's state between
      runs is an event of ours; anything that didn't fit is blocked with `request-feedback`, not improvised
- [ ] `act` only issues a command or starts a workflow; nothing is caught and logged
- [ ] Every field of the command comes from the item, the trigger event, or a data input read with `read`, per
      slice.json's mappings (ADR-039)
- [ ] External: the workflow is deterministic, its retries are configuration, and business answers are recorded as
      our commands through `issueOnce` with the key from the description
- [ ] External: the provider skill read and followed; its official SDK, host and our deadline from the environment,
      never charging or sending twice
- [ ] External: the outside call's final failure is caught only to record the stall (with its category) and alert;
      the recording activities retry without limit
- [ ] An item worked again passes its `attempt` to `issue`/`start`, and answers are keyed per attempt
- [ ] External: the mock follows the provider's API and sandbox test values, with a Dockerfile and compose service
- [ ] One `test(...)` per specification, through `automationTestApp`
- [ ] `src/workflows.ts` only gains a line; `src/index.ts` wiring in its own commit
