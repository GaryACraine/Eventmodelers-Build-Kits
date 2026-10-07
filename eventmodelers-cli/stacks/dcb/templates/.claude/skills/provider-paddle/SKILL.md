---
name: provider-paddle
description: Paddle (a merchant of record) for the slices that touch it. What Paddle tells us (reading an event as our notification, a webhook's signature, fetching its event stream after a checkpoint), what we ask it to do (seat changes, cancel), and its checkout opened from our page (Paddle.js in web/). The errors, the mock and the sandbox. Read it when a slice's description or a field's mapping names Paddle. A draft on first use.
---

# Paddle: what it tells us, what we ask of it, and its checkout

> **Draft, on first use** (ADR-042's rule: distil on solid ground). The code below is proven by its own tests against
> a mock, real sandbox payloads and answers, and the sandbox over HTTP (`licensing/e2e/paddle/`, 32 cases, and
> `licensing/web/e2e/paddle/`, 15 cases), not yet by a slice the loop built. Follow it; where a slice doesn't fit, block the job with `request-feedback` saying
> what didn't fit. This skill is rewritten from the lessons once the first slices and the end-to-end run pass.

`build-automation` holds what's true of every automation. This skill holds what's true of **Paddle**. Decisions:
ADR-036 (Paddle), ADR-037 (seats), ADR-040 (the inbox), ADR-041 (webhooks first, a fetch of the event stream behind
them), ADR-042 (timed work on Temporal), ADR-044 (its checkout in our page). The facts are in `docs/case-studies/paddle.md` §7 and §7b.

Checked against `@paddle/paddle-node-sdk` 3.10 and Paddle's sandbox (2026-10-02). Where they differ from what you'd
assume, this skill says so: follow it, not memory.

## What Paddle tells us, and how it reaches us

Paddle tells us what happened to a subscription in two ways, and both are recorded as the same event of ours:

- **a webhook** to `POST /webhooks/paddle`: fast, but it can be late, repeated, out of order or lost;
- **its event stream**, `GET /events`: every event of the last 90 days, with the webhook's `event_id` and payload,
  read oldest first after a checkpoint.

Both record `paddleNotificationReceived` through `recordNotification` (`src/shared/inbox.ts`) under the idempotency
key `paddle:<event_id>`, so the same event by both routes is one item. **Order across the two routes isn't Paddle's:**
never rely on the inbox's order; the deciders compare `paddleOccurredAt`.

The envelope is the same in both: `event_id`, `event_type`, `occurred_at`, `data` (the whole entity as it now stands).
A webhook adds `notification_id`.

## Where the code goes

| What | Where | Needs |
|---|---|---|
| what Paddle tells us (the inbox, the fetch) | `src/providers/paddle/paddle.ts` | `@paddle/paddle-node-sdk` in `package.json` |
| what we ask Paddle to do (seats, cancel) | `src/providers/paddle/calls.ts` | nothing more |
| its checkout, from our page | `web/src/providers/paddle/checkout.ts` | `@paddle/paddle-js` in `web/package.json` |

Each is created by the first slice that needs it and shared by the others. If a package is missing, block the job
asking for it (`npm install @paddle/paddle-node-sdk`, `npm --prefix web install @paddle/paddle-js`): a slice never
changes a `package.json`.

## Configuration, from the environment

| Variable | Default | What |
|---|---|---|
| `PADDLE_API_URL` | `http://localhost:4020` (the mock) | the sandbox is `https://sandbox-api.paddle.com`, production `https://api.paddle.com` |
| `PADDLE_API_KEY` | `mock-api-key` | needs permission to read events and notifications |
| `PADDLE_WEBHOOK_SECRET` | `mock-webhook-secret` | the notification destination's `endpoint_secret_key` |
| `PADDLE_TIMEOUT_MS` | `10000` | our deadline per call, below the activity's `startToCloseTimeout` |

**Paddle's API is called over plain HTTP (`fetch`), not through the SDK.** The SDK knows only Paddle's sandbox and
production hosts, so it can't be pointed at the mock (ADR-030), and it returns converted entities where the inbox
keeps the payload as it arrived. The SDK checks the webhook's signature, and nothing else here.

## Reading an event as our notification

```typescript
/** A Paddle event as our `paddleNotificationReceived`, with the payload as it arrived. Throws if it can't be read. */
export function toNotification(body: unknown, receivedAt: Date = new Date()): Notification {
    const event = body as Partial<PaddleEvent>
    if (!event?.event_id || !event.event_type || !event.occurred_at || typeof event.data !== "object" || event.data === null) {
        throw new Error("not a Paddle event: event_id, event_type, occurred_at and data are required")
    }
    // A subscription's own events carry its id; a transaction's carry the subscription it belongs to, if any
    const subscriptionId = event.event_type.startsWith("subscription.") ? event.data["id"] : event.data["subscription_id"]
    const data = {
        paddleEventId: event.event_id,
        eventType: event.event_type,
        paddleOccurredAt: event.occurred_at,
        ...(typeof subscriptionId === "string" ? { subscriptionId } : {}),
        payload: body,
        receivedAt: receivedAt.toISOString()
    }
    return {
        id: event.event_id,
        event: {
            event: { type: "paddleNotificationReceived", data },
            tags: Tags.fromObj({ paddleEventId: event.event_id, ...(typeof subscriptionId === "string" ? { subscriptionId } : {}) })
        }
    }
}
```

- `payload` is the body **as it arrived**: never reshape it. The translation reads what it needs from it.
- `subscriptionId` is `data.id` for a `subscription.*` event and `data.subscription_id` for a `transaction.*` one
  (which can be null: then there's no such field or tag).
- **Every event of ours recorded from a Paddle notification** (it carries `paddleEventId`: `trialWasStarted`,
  `paddleNotificationSkipped`, …) is tagged `paddleEventId`, and `subscriptionId` when it has one, as well as its own
  entity's id (ADR-040, ADR-048). The untranslated notifications list finds an outcome by `paddleEventId`, and the
  deciders read a subscription's events by `subscriptionId`. The model marks both as ids; if it doesn't, block the
  job and say so.
- **The types we translate** are a constant of the module (`subscription.created`, `.trialing`, `.activated`,
  `.updated`, `.past_due`, `.canceled`, `transaction.completed`). The fetch asks for those only, and the notification
  destination subscribes to the same list. A type the slices' descriptions add goes there.
- **A subscription's start has no single event.** A purchase or a trial made at Paddle's checkout sent **no
  `subscription.created`** (sandbox, twice): a trial sent `subscription.trialing`, a paid purchase
  `subscription.activated`. One made through the API sent `created` as well. So a start is whichever of them arrives
  first, read with the payload's `status` (`trialing` or `active`), and the other is already done.
- **`transaction.completed` names its subscription** (`data.subscription_id`) and carries our `custom_data`, so the
  transaction the page reported can be matched to its subscription.

## The webhook endpoint

```typescript
/** The webhook endpoint's inbox (`configureWebhookInbox`): Paddle's signature, checked by its SDK against the raw body. */
export function paddleInbox(config: Pick<PaddleConfig, "apiKey" | "webhookSecret">): WebhookInbox {
    const paddle = new Paddle(config.apiKey)
    return {
        system: "paddle",
        path: "/webhooks/paddle",
        verify: async (rawBody, headers) => {
            const signature = headers["paddle-signature"]
            if (typeof signature !== "string") return false
            // False for a wrong secret, a changed body, or a timestamp more than 5 seconds from now (the SDK's rule)
            return paddle.webhooks.isSignatureValid(rawBody.toString("utf8"), config.webhookSecret, signature).catch(() => false)
        },
        toEvent: body => toNotification(body)
    }
}
```

It's built by the slice of the external event `paddleNotificationReceived` (`sliceType: "EXTERNAL_EVENT"`,
`build-automation`'s section "An external event"): `inbox.ts` exports `paddleInbox(paddleConfig())`, wired as
`configureWebhookInbox({ eventStore }, paddleNotificationInbox)` with `configureJsonBody()` in `apis` (the scaffold
has it): the signature is checked against the raw body. Real deliveries passed this check through a tunnel
(2026-10-03), and `e2e/paddle/fixtures/webhook-delivery.json` holds one as Paddle sent it.

- The header is `Paddle-Signature: ts=<unix>;h1=<hex>`, where `h1` is the HMAC-SHA256 of `<ts>:<raw body>` with the
  destination's secret.
- **The SDK refuses a timestamp more than 5 seconds from now.** A saved webhook can't be replayed with its original
  signature: tests sign it again (the mock's `paddleSignature`).
- Paddle wants **200 within 5 seconds**: the route records and answers, and does nothing else.
- **Later, with the Paddle Sync** (a polling automation, not built yet): after a webhook is recorded, trigger the
  sync (`scheduleWatch.trigger("paddle-sync")`) so it fills any gap before it. Best-effort: a failed trigger doesn't
  fail the webhook. Only when the slice's description says the sync exists.

## Fetching the event stream

```typescript
export async function fetchPaddleEvents(
    deps: { eventStore: EventStore; config: PaddleConfig },
    after?: string,
    options: { perPage?: number; eventTypes?: string[] } = {}
): Promise<{ fetched: number; upTo?: string }> {
    const { eventStore, config } = deps
    let cursor = after
    let fetched = 0
    for (;;) {
        const url = new URL("/events", config.apiUrl)
        url.searchParams.set("order_by", "id[ASC]")
        url.searchParams.set("per_page", String(options.perPage ?? 200))
        const types = options.eventTypes ?? PADDLE_EVENT_TYPES
        if (types.length > 0) url.searchParams.set("event_type", types.join(","))
        if (cursor) url.searchParams.set("after", cursor)

        const page = await paddleRequest<EventsPage>(config, "GET", url) // the request helper, under "What we ask Paddle to do"
        for (const event of page.data) {
            await recordNotification(eventStore, "paddle", toNotification(event))
            cursor = event.event_id
            fetched++
        }
        if (page.data.length === 0 || !page.meta?.pagination?.has_more) return { fetched, ...(cursor ? { upTo: cursor } : {}) }
    }
}
```

- `after` is the checkpoint; none means from the start of what Paddle keeps.
- Up to 200 a page; `meta.pagination.has_more` says whether to go on. **`estimated_total` is an estimate** (it said
  1,850 for a stream holding 156): never rely on it.
- If a page fails, what was recorded stays recorded and the error is thrown. No checkpoint was recorded, so the next
  fetch starts from the old one and the events already in are no-ops.

### The errors

| Paddle answers | Means | In an activity |
|---|---|---|
| 401, 403 | our key is refused | `ApplicationFailure.nonRetryable(message, "configuration")` |
| 429 | busy: 240 requests a minute per IP address | retryable, `"unavailable"`; wait its `Retry-After` |
| 5xx, no answer by our deadline, the network | Paddle or the path to it is down | retryable, `"unavailable"` |

A failed run of the sync alerts and ends; the next run tries again (`build-automation`, "A polling automation").

### The checkpoint

The checkpoint is **an event of ours** (`paddleEventsWereFetched`, with `upToPaddleEventId`), never Temporal's state.

- **Reading it:** the greatest `upToPaddleEventId` among the recent `paddleEventsWereFetched` events. "The greatest",
  not "the latest recorded", so it only moves forward even if a slow run records its older checkpoint afterwards.
  Paddle's event ids sort by time (they're ULIDs; observed, not documented).
- **Recording it:** once per checkpoint, `issueOnce(deps, "paddle-sync:<event id>", …)`, and only when the fetch
  moved it. A run that finds nothing new records nothing.
- **One run** is: read the checkpoint, fetch and record, record the new checkpoint. That's the sync's one activity,
  and the checkout watch's `fetchEvents` is the same run.

## What we ask Paddle to do: `src/providers/paddle/calls.ts`

Changing a subscription's seats, cancelling it at the period's end, and withdrawing that cancellation (ADR-037). Each
is the work of an external automation's **activity**, so each must be safe to run again.

**One request helper, in `paddle.ts`,** used by the fetch and by these calls. It gives every failure a `kind`:

```typescript
/** A call to Paddle failed. `kind` says what a retry can do about it. */
export class PaddleApiError extends Error {
    constructor(
        message: string,
        /**
         * unavailable: try again (a busy or failing Paddle, the network, our deadline);
         * configuration: a person must fix it (the key);
         * refused: Paddle answered that it won't do this (`code` says why); trying again changes nothing
         */
        readonly kind: "unavailable" | "configuration" | "refused",
        readonly status?: number,
        /** Paddle's `Retry-After`, on a 429 */
        readonly retryAfterSeconds?: number,
        /** Paddle's error code, e.g. `subscription_locked_pending_changes` */
        readonly code?: string
    ) {
        super(message)
        this.name = "PaddleApiError"
    }
}

/**
 * One call to Paddle's API, over plain HTTP with our deadline. Returns the answer's body; throws a `PaddleApiError`
 * that says whether a retry can help.
 */
export async function paddleRequest<T>(config: PaddleConfig, method: "GET" | "POST" | "PATCH", url: URL | string, body?: unknown): Promise<T> {
    const target = typeof url === "string" ? new URL(url, config.apiUrl) : url
    const what = `${method} ${target.pathname}`
    let response: Response
    try {
        response = await fetch(target, {
            method,
            headers: { Authorization: `Bearer ${config.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(config.timeoutMs)
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new PaddleApiError(`Paddle didn't answer ${what} within ${config.timeoutMs} ms (${reason})`, "unavailable")
    }
    if (response.ok) return (await response.json()) as T
    const text = await response.text().catch(() => "")
    if (response.status === 401 || response.status === 403) {
        throw new PaddleApiError(`Paddle refused our API key (${response.status}): ${text.slice(0, 200)}`, "configuration", response.status)
    }
    if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"))
        throw new PaddleApiError(
            `Paddle answered ${what} with ${response.status}: ${text.slice(0, 200)}`,
            "unavailable",
            response.status,
            response.status === 429 && Number.isFinite(retryAfter) ? retryAfter : undefined
        )
    }
    // Any other 4xx: Paddle understood and won't do it. Its error says why
    let error: { code?: string; detail?: string } = {}
    try {
        error = (JSON.parse(text) as { error?: typeof error }).error ?? {}
    } catch {
        // not JSON: the status alone
    }
    throw new PaddleApiError(`Paddle refused ${what} (${response.status}${error.code ? ` ${error.code}` : ""}): ${error.detail ?? text.slice(0, 200)}`, "refused", response.status, undefined, error.code)
}
```

```typescript
import { PaddleApiError, paddleRequest, type PaddleConfig } from "./paddle.js"

/**
 * What we ask Paddle to do to a subscription (ADR-037): change its seats, cancel it at the period's end, and withdraw
 * that cancellation. Each is the work of an external automation's activity, so each is **safe to run again**: Paddle
 * is told the state we want (every item with its quantity), never a difference.
 *
 * A decisive answer (the subscription in its new state) is a fact: the workflow records it at once as our command
 * (ADR-049). Paddle's own event of the same change carries the same `updated_at` (the subscription's version), so
 * whichever of the two is recorded second is skipped as already done.
 */

/** A seat type's price at Paddle, and how many seats of it */
export interface SeatItem {
    priceId: string
    quantity: number
}

/**
 * How Paddle bills a change of seats:
 * - `prorated_immediately`: charge the rest of the period now (adding seats). A declined card refuses the change;
 * - `do_not_bill`: no charge and no credit (removing seats: the next renewal is for the lower number; and any change
 *   during a trial, where it's the only mode Paddle allows).
 */
export type ProrationMode = "prorated_immediately" | "do_not_bill"

/** A subscription as Paddle has it now, as far as our activities read it */
export interface PaddleSubscription {
    subscriptionId: string
    status: string
    items: SeatItem[]
    /** None while a cancellation is scheduled */
    nextBilledAt?: string
    scheduledChange?: { action: string; effectiveAt: string }
    updatedAt: string
}

export interface Money {
    /** In the currency's lowest unit (pence), tax included */
    amount: number
    currencyCode: string
}

export interface SeatChangePreview {
    /** Charged at once if the change is made; none when nothing is charged now */
    dueNow?: Money
    /** The next renewal after the change, and when */
    nextBill?: Money & { at: string }
}

interface SubscriptionEntity {
    id: string
    status: string
    items: { price: { id: string }; quantity: number }[]
    next_billed_at: string | null
    scheduled_change: { action: string; effective_at: string } | null
    updated_at: string
}
interface Totals {
    grand_total: string
    currency_code: string
}
interface PreviewEntity extends SubscriptionEntity {
    immediate_transaction: { details: { totals: Totals } } | null
    next_transaction: { billing_period: { starts_at: string }; details: { totals: Totals } } | null
}

const toSubscription = (entity: SubscriptionEntity): PaddleSubscription => ({
    subscriptionId: entity.id,
    status: entity.status,
    items: entity.items.map(item => ({ priceId: item.price.id, quantity: item.quantity })),
    ...(entity.next_billed_at ? { nextBilledAt: entity.next_billed_at } : {}),
    ...(entity.scheduled_change ? { scheduledChange: { action: entity.scheduled_change.action, effectiveAt: entity.scheduled_change.effective_at } } : {}),
    updatedAt: entity.updated_at
})
const money = (totals: Totals): Money => ({ amount: Number(totals.grand_total), currencyCode: totals.currency_code })
const seatsBody = (items: SeatItem[], mode: ProrationMode) => ({
    items: items.map(item => ({ price_id: item.priceId, quantity: item.quantity })),
    proration_billing_mode: mode
})
const path = (subscriptionId: string, rest = "") => `/subscriptions/${encodeURIComponent(subscriptionId)}${rest}`

export async function getSubscription(config: PaddleConfig, subscriptionId: string): Promise<PaddleSubscription> {
    return toSubscription((await paddleRequest<{ data: SubscriptionEntity }>(config, "GET", path(subscriptionId))).data)
}

/** What a change of seats would cost, without making it: for the screen that asks the owner to confirm */
export async function previewSeatChange(config: PaddleConfig, subscriptionId: string, items: SeatItem[], mode: ProrationMode): Promise<SeatChangePreview> {
    const { data } = await paddleRequest<{ data: PreviewEntity }>(config, "PATCH", path(subscriptionId, "/preview"), seatsBody(items, mode))
    return {
        ...(data.immediate_transaction ? { dueNow: money(data.immediate_transaction.details.totals) } : {}),
        ...(data.next_transaction ? { nextBill: { ...money(data.next_transaction.details.totals), at: data.next_transaction.billing_period.starts_at } } : {})
    }
}

/**
 * Set the subscription's seats: every item with its quantity, never a difference. Asked again with the same numbers,
 * Paddle changes and charges nothing (seen in the sandbox), so a retried activity is safe.
 */
export async function changeSeats(config: PaddleConfig, subscriptionId: string, items: SeatItem[], mode: ProrationMode): Promise<PaddleSubscription> {
    return toSubscription((await paddleRequest<{ data: SubscriptionEntity }>(config, "PATCH", path(subscriptionId), seatsBody(items, mode))).data)
}

/**
 * Cancel a subscription. Safe to run again:
 * - `"at the period's end"` (the owner cancels): Paddle schedules it, and the subscription stays as it is until then.
 *   Asked again, Paddle refuses (`subscription_locked_pending_changes`): if the cancellation is the change that's
 *   pending, it's done;
 * - `"now"` (a trial we refused, before anything is charged): the subscription is cancelled at once. Asked again,
 *   Paddle refuses because it's cancelled (`subscription_update_when_canceled`): done.
 */
export async function cancelSubscription(config: PaddleConfig, subscriptionId: string, when: "at the period's end" | "now" = "at the period's end"): Promise<PaddleSubscription> {
    try {
        const { data } = await paddleRequest<{ data: SubscriptionEntity }>(config, "POST", path(subscriptionId, "/cancel"), {
            effective_from: when === "now" ? "immediately" : "next_billing_period"
        })
        return toSubscription(data)
    } catch (error) {
        if (!(error instanceof PaddleApiError) || (error.code !== "subscription_locked_pending_changes" && error.code !== "subscription_update_when_canceled")) throw error
        const current = await getSubscription(config, subscriptionId)
        if (current.status === "canceled" || (when === "at the period's end" && current.scheduledChange?.action === "cancel")) return current
        throw error
    }
}

/** Withdraw a scheduled cancellation. With none scheduled, Paddle changes nothing */
export async function withdrawCancellation(config: PaddleConfig, subscriptionId: string): Promise<PaddleSubscription> {
    return toSubscription((await paddleRequest<{ data: SubscriptionEntity }>(config, "PATCH", path(subscriptionId), { scheduled_change: null })).data)
}
```

- **Paddle is told the state we want, never a difference:** every item with its quantity. **Asked again with the
  same numbers, Paddle changes nothing and charges nothing** (sandbox, 2026-10-02: one charge for two identical
  calls, and `updated_at` unchanged). That's what makes a retried activity safe.
- **The billing mode:**
  - adding seats: `prorated_immediately`. Paddle charges the rest of the period at once; a declined card refuses the
    change and the seats stay as they were;
  - removing seats: `do_not_bill`. No charge and no credit, and the next renewal is for the lower number;
  - **during a trial, only `do_not_bill`** (Paddle refuses the others), and items can't be added or removed.
- **A second cancel is refused** (`subscription_locked_pending_changes`). If the pending change is the cancellation,
  it's done; `cancelSubscription` reads the subscription to see. While a cancellation is scheduled, seats can still
  be changed.
- **Cancelling now** (`cancelSubscription(…, "now")`, Paddle's `effective_from: immediately`) is for a trial we
  refused, before anything is charged. It cancels at once, even with a cancel already scheduled, and Paddle sends
  `subscription.canceled`. Asked again, Paddle refuses (`subscription_update_when_canceled`): done.
- **Withdrawing** is `scheduled_change: null`. With nothing scheduled, Paddle changes nothing.
- **A decisive answer is a fact, recorded at once** (ADR-049, Proposed). The workflow records it as our command,
  through an activity, as `build-automation` says:
  - **decisive:** the subscription in its new state. A cancel `immediately` answers `status: canceled` with
    `canceled_at`; a cancel at the period's end answers `scheduled_change` (`action: cancel`, `effective_at`); a seat
    change answers every item with its quantity; a withdrawal answers `scheduled_change: null`;
  - the event carries `subscriptionId` and the subscription's version, `paddleUpdatedAt` (the answer's
    `updated_at`), and no `paddleEventId`: no event of Paddle's has arrived yet;
  - **not decisive:** no answer by our deadline, or a 429 or 5xx once the retries run out. Record nothing; the fact
    comes from Paddle's event (webhook or fetch), and the stall rules apply.
- **A change is recognised by the subscription's version, `updated_at`** (sandbox, 2026-10-07: 10 of 10 answers
  matched their events to the millisecond; licensing `e2e/paddle/answer-vs-event.mjs`). Our answer and every event
  of that change (`subscription.updated`, and `subscription.canceled` for a cancel) carry the same `updated_at`; a
  repeat of the same request answers the previous one and makes no event. Paddle sends its event for a change made
  through the API too, within a second, so **either report may arrive first**. The command that records a report
  reads the subscription's events by `subscriptionId` and compares `paddleUpdatedAt` with the latest recorded:
  - **the same:** already done. From Paddle's event, record `paddleNotificationSkipped`, "already done", so the
    notification leaves the to-do list; from our answer, record nothing more;
  - **older:** superseded by a later change already recorded; skipped the same way;
  - **newer, or none recorded:** a new change; record it.

  Every event recorded from a subscription change carries `paddleUpdatedAt` (from Paddle's event: `data.updated_at`).
  Don't match on `occurred_at` (the event's time, about 200 ms after the change) or on the state alone (1 → 2 → 1
  seats).
- **Never put a request id of ours in `custom_data`** to match a change: setting it is a change of its own (a new
  version and event, even for the same numbers), and it stays on the subscription, so later changes carry it.
- **What we didn't start comes only from Paddle's events:** renewals, a failed payment and its recovery, the
  customer's portal, a change made in Paddle's dashboard.
- **The preview** (`previewSeatChange`) is for the screen that asks the owner to confirm: a read, called by a route of
  ours, never by the browser (the API key is the backend's).

| Paddle answers | `kind` | In an activity |
|---|---|---|
| 401, 403 | `configuration` | `ApplicationFailure.nonRetryable(message, "configuration")` |
| 429, 5xx, no answer by our deadline | `unavailable` | retryable; wait a 429's `Retry-After` |
| any other 4xx | `refused`, with Paddle's `code` | non-retryable, with the code: the workflow records the outcome the slice names |

Codes seen in the sandbox: `not_found` (404), `subscription_update_when_canceled`,
`subscription_locked_pending_changes`, and "cannot update subscription, as the subscription status is 'past_due'".
**The code of a declined card on a seat increase isn't recorded yet:** the first slice that handles it reads it from
the sandbox (card `4000 0027 6000 3184`) and adds it here.

## Its checkout, from our page: `web/src/providers/paddle/checkout.ts`

The owner pays in **Paddle's form, put inside our page by Paddle.js** (its inline checkout, ADR-044). `build-screen` holds what's true
of any screen; this is what's true of Paddle's checkout.

```typescript
import { initializePaddle, type InitializePaddleOptions, type Paddle, type PaddleEventData } from "@paddle/paddle-js"

/**
 * Paddle's checkout, opened from our page (Paddle.js, ADR-036). The buyer pays in Paddle's overlay; this module
 * says whether the checkout completed, and for which transaction. That's all the page learns from it: what was
 * bought comes only from Paddle's own events, through the inbox (ADR-040, ADR-041). The page reports the completion
 * to our backend so it looks for those events at once.
 *
 * `mock` (the default) has no Paddle.js: the checkout is a request to the mock Paddle, which completes it at once
 * and makes the events Paddle would (ADR-030). So the app runs, and is tested, with no account at Paddle.
 */
export interface PaddleWebConfig {
    environment: "mock" | "sandbox" | "production"
    /** Paddle's client-side token (`test_…` in the sandbox, `live_…` in production). Public: it ships in the page */
    clientToken: string
    /** Where the mock Paddle runs */
    mockUrl: string
}

type Env = Record<string, string | undefined>

export function paddleWebConfig(env: Env = import.meta.env): PaddleWebConfig {
    const environment = env.VITE_PADDLE_ENVIRONMENT || "mock"
    if (environment !== "mock" && environment !== "sandbox" && environment !== "production") {
        throw new Error(`VITE_PADDLE_ENVIRONMENT is "${environment}": mock, sandbox or production`)
    }
    const clientToken = env.VITE_PADDLE_CLIENT_TOKEN ?? ""
    if (environment !== "mock" && !clientToken) throw new Error("VITE_PADDLE_CLIENT_TOKEN isn't set")
    return { environment, clientToken, mockUrl: env.VITE_PADDLE_MOCK_URL || "http://localhost:4020" }
}

/** A price's id at Paddle, by our name for it: `paddlePrice("WEB_TRIAL")` is `VITE_PADDLE_PRICE_WEB_TRIAL`. */
export function paddlePrice(name: string, env: Env = import.meta.env): string {
    const id = env[`VITE_PADDLE_PRICE_${name}`]
    if (!id) throw new Error(`VITE_PADDLE_PRICE_${name} isn't set`)
    return id
}

export interface CheckoutRequest {
    items: { priceId: string; quantity: number }[]
    /** Ours, kept by Paddle on the transaction and copied onto the subscription: the organisation's id goes here */
    customData: Record<string, unknown>
    /** Fills in the buyer's email, so they aren't asked for it */
    customerEmail?: string
    /**
     * The class of the element on our page that Paddle's payment form goes in (its inline checkout). Without it,
     * Paddle's overlay opens over the page. The inline form shows no list of what's being bought, so the buyer can't
     * change it there, and our page shows it (`onSummary`).
     */
    frame?: string
    /**
     * Told what Paddle will charge, when the checkout loads and whenever that changes (the tax follows the buyer's
     * country). For showing beside the inline form only: never sent to our backend. The mock doesn't call it.
     */
    onSummary?: (summary: CheckoutSummary) => void
}

/** What Paddle says it will charge. Amounts include tax and are in the currency's main unit (pounds, not pence) */
export interface CheckoutSummary {
    currencyCode: string
    dueToday: number
    /** Each billing period after today's charge, and the tax in it; none for a one-off purchase */
    recurring?: { total: number; tax: number }
    items: { priceId: string; name: string; quantity: number; total: number; recurringTotal?: number }[]
}

/** Completed, with Paddle's transaction id; or closed by the buyer before paying */
export type CheckoutOutcome = { completed: true; transactionId: string } | { completed: false }

export interface PaddleCheckout {
    /** Opens the checkout. Resolves when it completes or the buyer closes it; rejects if it couldn't open */
    open(request: CheckoutRequest): Promise<CheckoutOutcome>
}

export class PaddleCheckoutError extends Error {
    constructor(
        message: string,
        readonly code?: string
    ) {
        super(message)
        this.name = "PaddleCheckoutError"
    }
}

type Loader = (options: InitializePaddleOptions) => Promise<Paddle | undefined>

export function createPaddleCheckout(config: PaddleWebConfig, load: Loader = initializePaddle): PaddleCheckout {
    return config.environment === "mock" ? mockCheckout(config) : paddleJsCheckout(config, load)
}

let shared: PaddleCheckout | undefined
/** The page's one checkout: Paddle.js is loaded and initialised once per page */
export const paddleCheckout = (): PaddleCheckout => (shared ??= createPaddleCheckout(paddleWebConfig()))

function paddleJsCheckout(config: PaddleWebConfig, load: Loader): PaddleCheckout {
    // One checkout is open at a time, and Paddle.js has one event callback: it reports to whichever is open
    let open: ((event: PaddleEventData) => void) | undefined
    let busy = false
    let paddle: Promise<Paddle> | undefined

    const loaded = () =>
        (paddle ??= load({
            environment: config.environment === "production" ? "production" : "sandbox",
            token: config.clientToken,
            eventCallback: event => open?.(event)
        }).then(instance => {
            if (!instance) throw new PaddleCheckoutError("Paddle.js didn't load")
            return instance
        })).catch(error => {
            paddle = undefined // the next attempt loads it again
            throw error
        })

    return {
        async open(request) {
            if (busy) throw new PaddleCheckoutError("A checkout is already open")
            busy = true
            const instance = await loaded().catch(error => {
                busy = false
                throw error
            })
            return new Promise<CheckoutOutcome>((resolve, reject) => {
                const settle = (outcome: CheckoutOutcome | PaddleCheckoutError) => {
                    open = undefined
                    busy = false
                    if (outcome instanceof PaddleCheckoutError) reject(outcome)
                    else resolve(outcome)
                }
                open = event => {
                    // Every event of the checkout carries what it now stands at (not Paddle.js's own, e.g. its size)
                    if (request.onSummary && event.data?.items && event.data.totals) {
                        const { data } = event
                        request.onSummary({
                            currencyCode: data.currency_code,
                            dueToday: data.totals.total,
                            ...(data.recurring_totals ? { recurring: { total: data.recurring_totals.total, tax: data.recurring_totals.tax } } : {}),
                            items: data.items.map(item => ({
                                priceId: item.price_id,
                                name: item.product.name,
                                quantity: item.quantity,
                                total: item.totals.total,
                                ...(item.recurring_totals ? { recurringTotal: item.recurring_totals.total } : {})
                            }))
                        })
                    }
                    switch (event.name) {
                        case "checkout.completed": {
                            const transactionId = event.data?.transaction_id
                            if (!transactionId) return settle(new PaddleCheckoutError("Paddle's checkout completed with no transaction"))
                            settle({ completed: true, transactionId })
                            // Our page says what happens next: Paddle's own "thank you" isn't shown
                            instance.Checkout.close()
                            return
                        }
                        case "checkout.closed":
                            return settle({ completed: false })
                        case "checkout.error":
                            // The checkout couldn't open or go on (e.g. a price that doesn't exist). A declined
                            // card is `checkout.payment.failed`: the buyer tries again inside Paddle's checkout
                            // Settled before closing: Paddle.js reports the close as `checkout.closed`
                            settle(new PaddleCheckoutError(event.detail ?? "Paddle's checkout failed", event.code))
                            instance.Checkout.close()
                            return
                    }
                }
                try {
                    instance.Checkout.open({
                        items: request.items,
                        customData: request.customData,
                        ...(request.customerEmail ? { customer: { email: request.customerEmail } } : {}),
                        settings: request.frame
                            ? {
                                  displayMode: "inline",
                                  frameTarget: request.frame,
                                  frameInitialHeight: 450,
                                  frameStyle: "width: 100%; min-width: 312px; background-color: transparent; border: none;",
                                  allowLogout: !request.customerEmail
                              }
                            : { displayMode: "overlay", allowLogout: !request.customerEmail }
                    })
                } catch (error) {
                    settle(new PaddleCheckoutError(error instanceof Error ? error.message : String(error)))
                }
            })
        }
    }
}

function mockCheckout(config: PaddleWebConfig): PaddleCheckout {
    return {
        async open(request) {
            let response: Response
            try {
                response = await fetch(new URL("/mock/checkouts", config.mockUrl), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        items: request.items.map(item => ({ price_id: item.priceId, quantity: item.quantity })),
                        custom_data: request.customData,
                        ...(request.customerEmail ? { customer: { email: request.customerEmail } } : {})
                    })
                })
            } catch (error) {
                throw new PaddleCheckoutError(`The mock Paddle didn't answer: ${error instanceof Error ? error.message : String(error)}`)
            }
            if (!response.ok) throw new PaddleCheckoutError(`The mock Paddle answered ${response.status}`)
            const body = (await response.json()) as { transaction_id?: string }
            if (!body.transaction_id) throw new PaddleCheckoutError("The mock Paddle's checkout completed with no transaction")
            return { completed: true, transactionId: body.transaction_id }
        }
    }
}
```

- **A slice's component calls `paddleCheckout().open(…)`, never Paddle.js.** The items are the prices the slice's
  description names, by our names (`paddlePrice("WEB_TRIAL")`), and `customData` carries **`organisationId`**: Paddle
  copies it onto the subscription, which ties every later event to our organisation.
- **Then the page reports it:** when the outcome is `completed`, the form submits the slice's command with the
  `transactionId` (the field mapped `derived:Paddle.js checkout.completed data.transaction_id`). Not completed: the
  buyer closed it, nothing is sent and nothing is shown as an error.
- **The page learns nothing else from it.** What was bought comes from Paddle's own events; the report only starts
  the fetch for them (ADR-041). Never read seats, prices or a status from Paddle.js's event.
- **Paddle.js is loaded once per page,** from Paddle's CDN (its rule), by `initializePaddle`.
- **Always pass `frame`** (the class of an element on the page): Paddle's inline form shows only the buyer's details
  and the payment, with **no list of items**. Its overlay (no `frame`) lets the buyer change the numbers and remove an
  item, and no setting locks them, so we don't use it.
- **The page draws what's being bought,** beside the frame, from `onSummary`: each item, what's due today, and what's
  due each period after, with Paddle's tax for the buyer's country. Amounts are in pounds, not pence. It's for
  showing only: never sent to our backend. The mock doesn't call it, so the page must read well without it.
- **The seats are the ones Paddle's event states,** never the ones the page asked for. The client-side token is
  public, so a checkout can be opened with other items from outside our page. A trial that arrives without a web seat
  is refused and cancelled at Paddle at once (`refuseTrial`, the model's chapter 24).
- **A declined card stays inside Paddle's checkout** (`checkout.payment.failed`): the buyer tries again there. We
  build none of it.

### Configuration, from Vite's environment

| Variable | Default | What |
|---|---|---|
| `VITE_PADDLE_ENVIRONMENT` | `mock` | `sandbox` or `production` load Paddle.js |
| `VITE_PADDLE_CLIENT_TOKEN` | none | Paddle's client-side token (`test_…`, `live_…`); needed outside `mock`. Public: it ships in the page |
| `VITE_PADDLE_MOCK_URL` | `http://localhost:4020` | the mock Paddle |
| `VITE_PADDLE_PRICE_<NAME>` | none | a price's id at Paddle, by our name: `WEB_TRIAL`, `MOBILE_TRIAL`, `WEB`, `MOBILE` |

The API key and the webhook secret are the backend's: never a `VITE_` variable.

### What Paddle.js sends (sandbox, 2026-10-02)

- It sends events of its own with **no `name`** (`{ type: "checkout.ping.size", height }`). Ignore events the
  module doesn't name.
- `checkout.loaded` carries the items and the totals (`data.totals`: today; `data.recurring_totals`: each period),
  which `onSummary` reports.
- A checkout that can't open: `checkout.error` (`type: "api_error"`, `code: "validation"`, `detail: "One or more
  provided price_ids could not be found, …"`), then `checkout.closed` **when we close it**. So the error is settled
  before `Checkout.close()` is called, or the close would be read as "the buyer closed it".
- `checkout.loaded`, then `checkout.customer.created` when an email was passed.

### In tests and in mock mode

`mock` is the default, so a component's tests and `npm run dev:mock` never load Paddle.js. The mock checkout is one
request, which MSW answers from the slice's `handlers.ts`:

```ts
http.post(`${paddleWebConfig().mockUrl}/mock/checkouts`, () => HttpResponse.json({ transaction_id: "txn_01h8" }, { status: 201 }))
```

with the command's example `transactionId`. The module's own tests (`checkout.test.ts`, beside it) cover Paddle.js
through a fake loader (`createPaddleCheckout(config, load)`): completed, closed, an error, a declined card, one
checkout at a time, Paddle.js not loading, and the mock.

## The mock: `mocks/paddle/`

Built by the first slice that needs it, as `build-automation` says for any outside system:

- `GET /events`, as Paddle's API reference describes it: ascending by id, `after`, `per_page` (200 at most),
  `event_type`, a bearer key (403 otherwise), `meta.pagination.has_more`;
- a way to add events (Paddle had more happen), and switches for a failing answer (429 with `Retry-After`, 500), after
  a number of requests, so a failure midway can be reached;
- **a subscription's calls** (read, preview, change seats, cancel, withdraw), answering as Paddle does: the same
  numbers again change nothing, a second cancel is refused, an unknown or cancelled subscription is refused with
  Paddle's code. **Versions as Paddle keeps them** (ADR-049): a change gets a new `updated_at`, which its answer and
  the events it adds to the stream carry; a repeat answers the previous `updated_at` and adds no event;
- **a checkout,** `POST /mock/checkouts` with `{ items: [{ price_id, quantity }], custom_data }`, which the web app's
  mock checkout calls in place of Paddle.js. It completes at once, answers `{ transaction_id }`, and adds the events
  Paddle would for a trial (`subscription.trialing` and `transaction.completed`, made from real ones, with the
  items, the custom data and the transaction's id; **no `subscription.created`**, as at Paddle). It takes any origin and no API key: the browser calls it;
- it keeps what it was asked;
- `paddleSignature(rawBody, secret, at?)` and `webhookBody(event)`, to deliver a webhook as Paddle signs it.

Seed it from **real payloads**: `e2e/paddle/fixtures/` in the project holds events read from the sandbox's stream,
kept byte for byte, and Paddle's answers to the calls (a subscription, both previews, its refusals; the customer
portal's links redacted). Never write a Paddle payload from memory.

## Tests every Paddle slice needs

- the same event by the webhook and by the fetch is one item, in either order;
- a redelivered webhook records nothing more;
- a wrong secret, a changed body, an old timestamp, or no signature: 401 and nothing recorded;
- from a checkpoint, only what came after it; nothing new is a no-op;
- a busy or failing Paddle loses nothing: the next fetch finishes it;
- a call run twice changes Paddle once; a refusal carries Paddle's code and isn't retried;
- the checkout: completed sends the command with the transaction's id; closed sends nothing.

## Paddle's sandbox

`PADDLE_API_URL=https://sandbox-api.paddle.com` and a sandbox API key, in `e2e/.env.sandbox` (gitignored, never
committed). The sandbox retries a failed webhook 3 times in 15 minutes (production: 60 times over 3 days), and its
stream holds the events whether or not a notification destination exists.

**Receiving its webhooks on a laptop** needs a public address: `cloudflared tunnel --url http://localhost:<port>`
gives one for the session, and a sandbox notification destination (`POST /notification-settings`, or `PATCH` an
existing one's `destination`) points at `<address>/webhooks/paddle`. Seen that way (2026-10-03): a delivery is the
stream's event plus a `notification_id`, 0.7 s after it happened; `POST /notifications/{id}/replay` redelivers it
under a new `notification_id`; a failed delivery is retried after about 20 s and a minute. Pause the destination
(`active: false`) when done.
