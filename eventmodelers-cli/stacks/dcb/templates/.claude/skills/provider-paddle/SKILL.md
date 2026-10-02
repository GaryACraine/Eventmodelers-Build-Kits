---
name: provider-paddle
description: Paddle (a merchant of record) for the slices that receive what Paddle tells us. Reading a Paddle event as our notification, checking a webhook's signature, fetching Paddle's event stream after a checkpoint, the errors, the mock and the sandbox. Read it when a slice's description names Paddle. A draft on first use.
---

# Paddle, for the inbox and its fetch

> **Draft, on first use** (ADR-042's rule: distil on solid ground). The code below is proven by its own tests against
> a mock and real sandbox payloads (`licensing/e2e/paddle/`, 16 cases), not yet by a slice the loop built, and not yet
> against the sandbox over HTTP. Follow it; where a slice doesn't fit, block the job with `request-feedback` saying
> what didn't fit. This skill is rewritten from the lessons once the first slices and the end-to-end run pass.

`build-automation` holds what's true of every automation. This skill holds what's true of **Paddle**. Decisions:
ADR-036 (Paddle), ADR-040 (the inbox), ADR-041 (webhooks first, a fetch of the event stream behind them), ADR-042
(timed work on Temporal). The facts are in `docs/case-studies/paddle.md` §7 and §7b.

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

`src/providers/paddle/paddle.ts`, created by the first slice that needs it and shared by the others (the webhook's
slice, the sync, the checkout watch). `package.json` needs `@paddle/paddle-node-sdk`; if it's missing, block the job
asking for `npm install @paddle/paddle-node-sdk`.

## Configuration, from the environment

| Variable | Default | What |
|---|---|---|
| `PADDLE_API_URL` | `http://localhost:4020` (the mock) | the sandbox is `https://sandbox-api.paddle.com`, production `https://api.paddle.com` |
| `PADDLE_API_KEY` | `mock-api-key` | needs permission to read events and notifications |
| `PADDLE_WEBHOOK_SECRET` | `mock-webhook-secret` | the notification destination's `endpoint_secret_key` |
| `PADDLE_TIMEOUT_MS` | `10000` | our deadline per call, below the activity's `startToCloseTimeout` |

**The event stream is read over plain HTTP (`fetch`), not through the SDK.** The SDK knows only Paddle's sandbox and
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
- **The types we translate** are a constant of the module (`subscription.created`, `.activated`, `.updated`,
  `.past_due`, `.canceled`, `transaction.completed`). The fetch asks for those only, and the notification
  destination subscribes to the same list. A type the slices' descriptions add goes there.

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

Its route is `configureWebhookInbox({ eventStore }, paddleInbox(config))`, with `configureJsonBody()` in `apis`
(the scaffold has it): the signature is checked against the raw body.

- The header is `Paddle-Signature: ts=<unix>;h1=<hex>`, where `h1` is the HMAC-SHA256 of `<ts>:<raw body>` with the
  destination's secret.
- **The SDK refuses a timestamp more than 5 seconds from now.** A saved webhook can't be replayed with its original
  signature: tests sign it again (the mock's `paddleSignature`).
- Paddle wants **200 within 5 seconds**: the route records and answers, and does nothing else.
- After a webhook is recorded, the route **triggers the sync** (`scheduleWatch.trigger("paddle-sync")`), which fills
  any gap before it. Best-effort: a failed trigger doesn't fail the webhook (the next sweep covers it).

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

        const page = await getPage(url, config)
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

## The mock: `mocks/paddle/`

Built by the first slice that needs it, as `build-automation` says for any outside system:

- `GET /events`, as Paddle's API reference describes it: ascending by id, `after`, `per_page` (200 at most),
  `event_type`, a bearer key (403 otherwise), `meta.pagination.has_more`;
- a way to add events (Paddle had more happen), and switches for a failing answer (429 with `Retry-After`, 500), after
  a number of requests, so a failure midway can be reached;
- it keeps what it was asked;
- `paddleSignature(rawBody, secret, at?)` and `webhookBody(event)`, to deliver a webhook as Paddle signs it.

Seed it from **real payloads**: `e2e/paddle/fixtures/` in the project holds events read from the sandbox's stream,
kept byte for byte. Never write a Paddle payload from memory.

## Tests every Paddle slice needs

- the same event by the webhook and by the fetch is one item, in either order;
- a redelivered webhook records nothing more;
- a wrong secret, a changed body, an old timestamp, or no signature: 401 and nothing recorded;
- from a checkpoint, only what came after it; nothing new is a no-op;
- a busy or failing Paddle loses nothing: the next fetch finishes it.

## Paddle's sandbox

`PADDLE_API_URL=https://sandbox-api.paddle.com` and a sandbox API key, in `e2e/.env.sandbox` (gitignored, never
committed). The sandbox retries a failed webhook 3 times in 15 minutes (production: 60 times over 3 days), and its
stream holds the events whether or not a notification destination exists.
