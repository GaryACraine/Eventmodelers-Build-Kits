import express from "express"
import { toNodeHandler } from "better-auth/node"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { createAuth, type Auth } from "./auth.js"
import { loadConfig } from "./config.js"
import { emailSender } from "./email.js"
import { removeUnverifiedAccountsRegularly } from "./unverified.js"

/**
 * The sign-in service (ADR-055): Better Auth on Express 5, as in better-auth.com/docs/integrations/express. Its
 * handler is mounted before any body parser, which would otherwise consume the request first.
 */
export function createServer(auth: Auth): express.Express {
    const app = express()
    app.disable("x-powered-by")
    app.get("/health", (_req, res) => {
        res.json({ status: "ok" })
    })
    app.all("/api/auth/*splat", toNodeHandler(auth))
    return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const config = loadConfig()
    const pool = new Pool({ connectionString: config.databaseUrl, options: "-c search_path=auth" })
    const app = createServer(createAuth(config, emailSender(config), pool))
    // ADR-056 D12: accounts never verified are removed after AUTH_UNVERIFIED_RETENTION_DAYS
    const stopRemoving = removeUnverifiedAccountsRegularly(pool, config.unverifiedRetentionDays)
    const server = app.listen(config.port, () => {
        console.log(`[auth] sign-in (${config.deployment}) on port ${config.port}, served to the browser at ${config.baseURL}/api/auth`)
    })
    const stop = () => {
        stopRemoving()
        server.close(() => void pool.end().finally(() => process.exit(0)))
    }
    process.on("SIGTERM", stop)
    process.on("SIGINT", stop)
}
