---
name: build-automation
description: Implements a DCB automation slice (a to-do list worked by one processor; internal work issues our command, external work runs in a Temporal workflow) from a slice.json definition
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

Never catch an error in `act`, a workflow or an activity to "log and carry on". A thrown error in `act` blocks the
processor on that event, retries it with backoff and shows it on `GET /health/processors`. A thrown activity error is
retried by Temporal. Swallowing either loses the work silently.

---

## Step 1: Read the slice.json

- `processors[0]` is the automation:
  - `processorType`: `event-driven` is this skill. `synchronous` is a *translation* (another system's event arriving
    at a webhook), which isn't proven yet: block the job with `request-feedback` and stop.
  - `dependencies`:
    - `INBOUND reacts-to EVENT`: the **triggers**;
    - `INBOUND relates-to READMODEL`: the **to-do list**;
    - `OUTBOUND relates-to COMMAND`: the **commands** it leads to.
  - `description`: whether it's **internal** or **external**, the idempotency key (`stock-returner:<orderId>`), the
    workflow id (`payment-request:<orderId>`), what to call and what its answers mean, and any rulings. Follow it to
    the letter.
- `events[]`: the trigger events with their fields (the data `act` gets).
- `specifications[]`: GIVEN/THEN scenarios, with no WHEN. THEN is the command it issues, or nothing.

The automation's **name** is the part before `:` in its idempotency key or workflow id (`stock-returner`,
`payment-request`).

## Step 2: Check what it needs is built

The loop builds an automation after the slices it needs, so these exist:

- **the to-do list**: `src/contexts/{context}/slices/{list-slice}/readModel.ts`, `type: "database-projected"`, keyed by
  the trigger's id field, and registered in `src/index.ts` `readModels`;
- **each command's decider**: `src/contexts/{context}/slices/{command-slice}/decider.ts`.

If one is missing, or the list isn't `database-projected`, block the job naming what's missing. Don't build it here:
one job builds one slice.

---

## Internal automation

### `processor.ts`

File: `src/contexts/{context}/slices/{slicename}/processor.ts`

```typescript
import { defineAutomation } from "../../../../shared/automations.js"
import { StockToReturn, type StockToReturnDoc } from "../stock-to-return/readModel.js"
import { returnStock } from "../return-stock/decider.js"

/**
 * Stock Returner (internal): the to-do list StockToReturn, opened by orderPaymentFailed, closed by stockReturned.
 * For each open item it issues returnStock, once: the idempotency key is stock-returner:<orderId>.
 */
export const stockReturner = defineAutomation<StockToReturnDoc>({
    name: "stock-returner",
    todoList: StockToReturn,
    triggers: ["orderPaymentFailed"],
    act: async ({ item, issue }) =>
        issue(returnStock, {
            type: "returnStock",
            data: { orderId: item.orderId, restaurantId: item.restaurantId, menuItems: item.menuItems }
        })
})
```

- The command's data comes from `item` (the to-do list's document) or `event` (the trigger), as the command's field
  mappings in slice.json say (`stockDeducted.menuItems` → the list's `menuItems`).
- `issue` gives the command the idempotency key `<name>:<item key>`. A repeat (a retry after a crash, the same event
  handled again) is recognised and not decided again.

### Wiring (`src/index.ts`, committed separately: `chore: wire <Slice Name>`)

```typescript
import { stockReturner } from "./contexts/restaurant/slices/return-failed-order-stock/processor.js"

const automations: Automation[] = [stockReturner]
```

---

## External automation

The work is a call to a system we don't control, so it runs in a **Temporal workflow** named after the item. The
workflow calls the system in an activity, then records the answer as our command.

### The provider's SDK

Use the provider's **official SDK**, the one production will use. `package.json` can't change in a slice commit
(blocked-paths): if the SDK isn't installed, block the job, asking for it (`npm install <sdk>`) to be added.

### `workflow.ts`: deterministic, no I/O

```typescript
import { proxyActivities } from "@temporalio/workflow"
import type { PaymentRequestActivities } from "./activities.js"

export interface PaymentRequestInput {
    orderId: string
    amount: string
    paymentMethodNonce: string
}

// Retries, backoff and timeouts are configuration: no retry loops of our own.
const { chargeCard, recordPaid, recordFailed } = proxyActivities<PaymentRequestActivities>({
    startToCloseTimeout: "30 seconds",
    retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "1 minute", maximumAttempts: 10 }
})

export async function paymentRequest(input: PaymentRequestInput): Promise<void> {
    const answer = await chargeCard(input)
    if (answer.outcome === "paid") await recordPaid(input.orderId)
    else await recordFailed(input.orderId, answer.reason)
}
```

The workflow runs in Temporal's sandbox and is replayed from its history:
- **no I/O, clocks, random numbers or imports of our code** (only `import type`);
- inputs and results are plain JSON;
- **business state stays in our events**: the workflow calls, then records the answer as a command, and never keeps
  the answer to itself. It doesn't wait for a later answer either: one that arrives later comes in through a webhook
  and a command, not a signal the workflow waits for.

### `activities.ts`: the calls

```typescript
import type { EventStore } from "@dcb-es/event-store"
import type { Pool } from "pg"
import { issueOnce } from "../../../../shared/automations.js"
import { markOrderPaid } from "../mark-order-paid/decider.js"
import { markOrderPaymentFailed } from "../mark-order-payment-failed/decider.js"

export type ChargeAnswer = { outcome: "paid" } | { outcome: "declined"; reason: string }

export function paymentRequestActivities(deps: { eventStore: EventStore; pool: Pool; gateway: Gateway }) {
    return {
        async chargeCard(input: PaymentRequestInput): Promise<ChargeAnswer> { /* the SDK call, below */ },
        recordPaid: (orderId: string) =>
            issueOnce(deps, `payment-result:${orderId}`, markOrderPaid, { type: "markOrderPaid", data: { orderId } }),
        recordFailed: (orderId: string, reason: string) =>
            issueOnce(deps, `payment-result:${orderId}`, markOrderPaymentFailed, {
                type: "markOrderPaymentFailed",
                data: { orderId, reason }
            })
    }
}
export type PaymentRequestActivities = ReturnType<typeof paymentRequestActivities>
```

- **A business answer is a result, a technical failure is thrown.** A decline (a refused card, an unknown address) is
  returned, and the workflow records it with our command. A network error, timeout or 5xx is thrown, so Temporal
  retries it.
- **Never do the outside work twice.** Pass our key as the provider's idempotency key if it has one. If it has none,
  combine what it does have, as the slice's description says: look for an earlier attempt by our reference (e.g. a
  search by order id) before calling again; treat a "duplicate" or "already used" rejection as "look again", not as a
  decline.
- **Config comes from the environment**, with defaults that point at the mock (`localhost:<its port>`), so the
  provider's sandbox or production is a config change. Read how the SDK is pointed at a host from its own source in
  `node_modules`: some take it only from environment variables or constants.

### `processor.ts`

```typescript
import { defineAutomation } from "../../../../shared/automations.js"
import { PaymentsAwaiting, type PaymentsAwaitingDoc } from "../payments-awaiting/readModel.js"
import type { PaymentRequestInput } from "./workflow.js"

/** Payment Requester (external): one workflow per order, payment-request:<orderId>. */
export const paymentRequester = defineAutomation<PaymentsAwaitingDoc>({
    name: "payment-request",
    todoList: PaymentsAwaiting,
    triggers: ["paymentInitiated"],
    act: async ({ event, start }) => {
        const data = event.event.data as PaymentRequestInput
        const input: PaymentRequestInput = { orderId: data.orderId, amount: data.amount, paymentMethodNonce: data.paymentMethodNonce }
        await start("paymentRequest", [input])
    }
})
```

`start` names the workflow `<name>:<item key>`. Temporal runs it once: a repeated start joins it or, once it has
finished, does nothing.

### Registering it

- `src/workflows.ts`: add **one line** (in the slice commit; the file only grows):
  `export { paymentRequest } from "./contexts/restaurant/slices/request-payment/workflow.js"`
- `src/index.ts` (the wiring commit): add the automation to `automations`, and its activities to `activities`:
  ```typescript
  const activities = {
      ...paymentRequestActivities({ eventStore, pool, gateway: braintreeGateway() })
  }
  ```

### The mock of the outside system

Every outside system runs as a container locally and in tests (ADR-030). If `mocks/{system}/` doesn't exist, build it
in this job:

- **Follow the provider's published API**, only the endpoints our SDK calls. Read the SDK's request and response code
  in `node_modules` for the exact paths, formats (JSON or XML) and fields.
- **Answer as the provider's sandbox does**, using its documented test values (test card nonces, amounts that
  decline), so the model's scenarios run against it unchanged. Honour its duplicate rules and single-use values.
- **Keep what it was asked**, so a test can check nothing was charged twice.
- **Files:** `mocks/{system}/server.ts` (Node's `http`, no dependencies, erasable TypeScript only, so `node server.ts`
  runs it; export a `startMock(port)` for tests) and a `Dockerfile` (`FROM node:24-alpine`, `CMD ["node",
  "server.ts"]`), plus a service in `docker-compose.yml` publishing its port.

---

## `processor.tests.ts`: one test per specification

File: `src/contexts/{context}/slices/{slicename}/processor.tests.ts`. Specs are GIVEN/THEN. `automationTestApp`
starts the read models and automations as the app does, on a fresh database per test. It appends the GIVEN events in
**one** append, so the automation never sees part of the history.

**Internal:**

```typescript
import { describe, test, expect } from "vitest"
import { automationTestApp } from "@test/automationHarness"
import { orderPaymentFailed, stockDeducted, stockReturned } from "../../Events.js"
import { StockToReturn } from "../stock-to-return/readModel.js"
import { stockReturner } from "./processor.js"

describe("return failed order stock", () => {
    const app = automationTestApp({ readModels: [StockToReturn], automations: [stockReturner] })

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
        readModels: [PaymentsAwaiting],
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
            await app.given(paymentInitiated({ orderId: "o1", amount: "12.00", paymentMethodNonce: "fake-valid-nonce" }))
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
- **External: also test the activity against the mock**: a repeated call for the same order charges once.

---

## Files

```
src/contexts/{context}/slices/{slicename}/
├── processor.ts          ← defineAutomation (both kinds)
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
- [ ] `act` only issues a command or starts a workflow; nothing is caught and logged
- [ ] Every field of the command comes from the item or the trigger event, per slice.json's mappings
- [ ] External: the workflow is deterministic, its retries are configuration, and business answers are recorded as
      our commands through `issueOnce` with the key from the description
- [ ] External: the provider's official SDK, host from the environment, never charging or sending twice
- [ ] External: the mock follows the provider's API and sandbox test values, with a Dockerfile and compose service
- [ ] One `test(...)` per specification, through `automationTestApp`
- [ ] `src/workflows.ts` only gains a line; `src/index.ts` wiring in its own commit
