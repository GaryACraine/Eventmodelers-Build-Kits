import { describe, test, expect } from "vitest"
import { alerter } from "./alerts.js"

describe("alerts", () => {
    test("writes one JSON line an alert rule can match: level alert, a stable code, the severity", () => {
        const lines: string[] = []
        const alert = alerter(line => lines.push(line), () => new Date("2026-09-29T12:00:00Z"))
        alert({ code: "payment-stalled", severity: "critical", message: "Payment of o1 stalled", details: { orderId: "o1" } })
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0])).toEqual({
            level: "alert",
            at: "2026-09-29T12:00:00.000Z",
            code: "payment-stalled",
            severity: "critical",
            message: "Payment of o1 stalled",
            details: { orderId: "o1" }
        })
    })

    test("never fails the work that raised it", () => {
        const alert = alerter(() => {
            throw new Error("log sink down")
        })
        expect(() => alert({ code: "payment-stalled", severity: "warning", message: "x" })).not.toThrow()
    })
})
