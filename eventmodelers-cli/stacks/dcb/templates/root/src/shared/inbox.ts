import express from "express"
import type { IncomingHttpHeaders, IncomingMessage } from "node:http"
import type { EventStore, TaggedEvent } from "@dcb-es/event-store"
import type { WebApiSetup } from "@dcb-es/event-store-express"
import { idempotencyKeyFor } from "./idempotency.js"
import { alert as defaultAlert, type Alert } from "./alerts.js"

/**
 * Receiving another system's webhooks: an inbox on the event store (ADR-040).
 *
 * The endpoint is the inbox's door, and it's thin: it checks the signature, records the notification as an event of
 * the other system's lane (e.g. `paddleNotificationReceived`, with the payload as it arrived), and answers 200 at
 * once. There's no business logic in it. A **translation** (an automation that is a list of one,
 * `defineAutomation` with a `key`) works the recorded notifications afterwards and issues our commands.
 *
 *   - a bad signature → 401, nothing recorded;
 *   - a redelivery → 200, nothing recorded again: the notification's id at the other system is the idempotency key;
 *   - the append fails → 5xx, so the other system delivers it again;
 *   - signed, but we can't read it → 400 and an alert: the reader (`toEvent`) needs fixing before the other system
 *     stops retrying;
 *   - recorded (or a redelivery), and the 200 sent → `afterRecorded`, if given (best effort).
 *
 * What's true of one system (its signature header, its payload) is in its provider skill, which gives `verify` and
 * `toEvent`.
 */
export interface WebhookInbox {
    /** The other system, e.g. "paddle": the idempotency key is `<system>:<notification id>` */
    system: string
    /** e.g. "/webhooks/paddle". Under `/webhooks/`, where `configureJsonBody` keeps the raw body */
    path: string
    /** The system's signature check, over the body exactly as it arrived. False: 401, nothing recorded */
    verify(rawBody: Buffer, headers: IncomingHttpHeaders): boolean | Promise<boolean>
    /**
     * The notification as our event: its id at the other system, and the event (the payload as it arrived, tagged
     * with that id, e.g. `paddleEventId`, and with whatever its translation's commands decide by, e.g.
     * `subscriptionId`). Throws when the payload can't be read.
     */
    toEvent(body: unknown): Notification
}

/** A notification as our event, with its id at the other system (what `WebhookInbox.toEvent` returns) */
export interface Notification {
    id: string
    event: TaggedEvent
}

/**
 * Record a notification in the inbox, once: the idempotency key is `<system>:<its id at the other system>`. Whatever
 * brings it (the webhook endpoint, or a fetch of the other system's event stream, ADR-041) records it through here, so
 * the same notification by two routes is one event.
 */
export async function recordNotification(eventStore: EventStore, system: string, notification: Notification): Promise<void> {
    await eventStore.append({ events: [{ ...notification.event, id: idempotencyKeyFor(`${system}:${notification.id}`) }] })
}

type WithRawBody = IncomingMessage & { rawBody?: Buffer }

/**
 * The app's JSON parser, in place of the library's (`getApplication({ disableJsonMiddleware: true, apis:
 * [configureJsonBody(), …] })`, first in `apis`): the same parsing, and it keeps the raw body of requests under
 * `/webhooks/`, which a signature is checked against. A parsed body can't be turned back into the bytes that were
 * signed.
 */
export function configureJsonBody(): WebApiSetup {
    return router => {
        router.use(
            express.json({
                verify: (req, _res, buf) => {
                    if (req.url?.startsWith("/webhooks/")) (req as WithRawBody).rawBody = buf
                }
            })
        )
    }
}

export interface WebhookInboxDeps {
    eventStore: EventStore
    alert?: (alert: Alert) => void
    /**
     * Run after a notification is recorded (a redelivery too), once the 200 is sent: e.g. run the fetch of the other
     * system's event stream now, so it fills any gap before this notification (ADR-041), with
     * `() => scheduleWatch.trigger("paddle-sync")`. Best effort: a failure is logged, and the webhook was already
     * answered.
     */
    afterRecorded?: () => void | Promise<void>
}

export function configureWebhookInbox(deps: WebhookInboxDeps, inbox: WebhookInbox): WebApiSetup {
    const alert = deps.alert ?? defaultAlert
    return router => {
        router.post(inbox.path, async (req, res) => {
            if (!req.is("application/json")) {
                res.status(415).json({ title: "A notification is JSON" })
                return
            }
            const rawBody = (req as WithRawBody).rawBody
            if (!rawBody) {
                // Never record what couldn't be checked: the app isn't wired with configureJsonBody
                throw new Error(`${inbox.path}: no raw body to check the signature against (is configureJsonBody in apis?)`)
            }
            if (!(await inbox.verify(rawBody, req.headers))) {
                res.status(401).json({ title: "The signature doesn't match" })
                return
            }
            let notification: Notification
            try {
                notification = inbox.toEvent(req.body)
                if (!notification.id) throw new Error("the notification has no id")
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                alert({
                    code: "inbox-unreadable",
                    severity: "critical",
                    message: `A signed ${inbox.system} notification couldn't be read: ${message}`,
                    details: { system: inbox.system, path: inbox.path, error: message }
                })
                res.status(400).json({ title: "The notification couldn't be read", detail: message })
                return
            }
            // A redelivery has the same id: the event store finds it and appends nothing
            await recordNotification(deps.eventStore, inbox.system, notification)
            res.status(200).json({ received: true })
            if (deps.afterRecorded) {
                const afterRecorded = deps.afterRecorded
                void Promise.resolve()
                    .then(() => afterRecorded())
                    .catch(error =>
                        console.error(`${inbox.path}: after recording a notification: ${error instanceof Error ? error.message : String(error)}`)
                    )
            }
        })
    }
}
