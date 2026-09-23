import type { WebApiSetup } from "@dcb-es/event-store-express"

/**
 * CORS for a frontend served from another origin (the `web/` app on S3, or Vite's dev server).
 *
 * `origins` is `CORS_ORIGIN`: a comma-separated list of allowed origins ("http://localhost:5173,https://app.example.com"),
 * or "*". Unset or empty → no CORS headers, so only same-origin callers can read responses.
 * Put it first in `apis`, so it runs before every route. Preflights (OPTIONS) are answered here with 204.
 */
export function configureCors(origins = process.env["CORS_ORIGIN"]): WebApiSetup {
    const allowed = (origins ?? "")
        .split(",")
        .map(o => o.trim())
        .filter(Boolean)
    const any = allowed.includes("*")

    return router => {
        if (allowed.length === 0) return
        router.use((req, res, next) => {
            const origin = req.headers.origin
            if (!origin || !(any || allowed.includes(origin))) return next()
            res.setHeader("Access-Control-Allow-Origin", any ? "*" : origin)
            if (!any) res.vary("Origin")
            // ETag carries the write's position (read-your-writes); Location a created resource
            res.setHeader("Access-Control-Expose-Headers", "ETag, Location")
            if (req.method !== "OPTIONS") return next()
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, If-None-Match, Prefer, Last-Event-ID")
            res.setHeader("Access-Control-Max-Age", "600")
            res.status(204).end()
        })
    }
}
