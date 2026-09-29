/**
 * Telling the administrator that something needs a person (ADR-032): a payment stalled because our keys were refused,
 * the gateway stayed down past its retries, an SDK needs upgrading.
 *
 * An alert is operational, not a business event: the durable record is the stalled item on its to-do list, and the
 * alert only draws attention to it. So it's best-effort: a failed alert never fails the work that raised it.
 *
 * By default it writes one JSON line to stderr, `{"level":"alert","code":…,"severity":…,"message":…}`. In the
 * cloud, a log-based alert rule turns that line into an email or a page with no code of ours; or pass another sink
 * (an email transport, whose provider is checked for availability first). Grouping repeats is the alerting service's
 * job, not ours.
 */

export type AlertSeverity = "critical" | "warning"

export interface Alert {
    /** Stable, for alert rules to match: e.g. "payment-stalled" */
    code: string
    /** critical: a person must act (fix keys, upgrade); warning: worth knowing (an outage outlasted the retries) */
    severity: AlertSeverity
    message: string
    details?: Record<string, unknown>
}

export type AlertSink = (line: string) => void

export function alerter(sink: AlertSink = line => console.error(line), now: () => Date = () => new Date()): (alert: Alert) => void {
    return alert => {
        try {
            sink(JSON.stringify({ level: "alert", at: now().toISOString(), ...alert }))
        } catch {
            // Best-effort by design: the stalled item is the record; an alert that can't be written mustn't lose it
        }
    }
}

/** The app's alert: a JSON line on stderr */
export const alert = alerter()
