import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createServer as createHttpServer, type Server } from "node:http"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { runner } from "node-pg-migrate"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { Pool } from "pg"
import { createAuth } from "./auth.js"
import { loadConfig } from "./config.js"
import type { Email } from "./email.js"
import { createServer } from "./server.js"

/**
 * The sign-in service end to end, on a real Postgres with its migrations: sign up, verify the email from the link
 * that was sent, get the JWT, and check it the way our API does (ADR-037: the JWKS, the issuer, the audience,
 * `email_verified`). The emails are captured instead of sent.
 */
describe("the sign-in service", () => {
    let postgres: StartedPostgreSqlContainer
    let http: Server
    let base: string
    let pool: Pool
    const sent: Email[] = []

    beforeAll(async () => {
        postgres = await new PostgreSqlContainer("postgres:16").start()
        await runner({
            databaseUrl: postgres.getConnectionUri(),
            dir: fileURLToPath(new URL("../migrations", import.meta.url)),
            direction: "up",
            migrationsTable: "pgmigrations",
            schema: "auth",
            createSchema: true,
            migrationsSchema: "auth",
            createMigrationsSchema: true,
            log: () => {}
        })
        http = createHttpServer()
        await new Promise<void>(resolve => http.listen(0, resolve))
        const port = (http.address() as { port: number }).port
        base = `http://localhost:${port}`
        const config = loadConfig({
            DEPLOYMENT: "on-premises",
            BETTER_AUTH_URL: base,
            BETTER_AUTH_SECRET: "a-secret-of-at-least-32-characters-long",
            DATABASE_URL: postgres.getConnectionUri(),
            EMAIL_FROM: "no-reply@example.com",
            SMTP_URL: "smtp://unused:1025"
        })
        pool = new Pool({ connectionString: config.databaseUrl, options: "-c search_path=auth" })
        http.on("request", createServer(createAuth(config, async email => void sent.push(email), pool)))
    })

    afterAll(async () => {
        await new Promise(resolve => http?.close(resolve))
        await pool?.end()
        await postgres?.stop()
    })

    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: base, ...headers },
            body: JSON.stringify(body)
        })

    /** Wait on state with a deadline: the verification email is sent without being awaited */
    async function emailTo(address: string): Promise<Email> {
        const deadline = Date.now() + 5_000
        for (;;) {
            const email = sent.find(e => e.to === address)
            if (email) return email
            if (Date.now() > deadline) throw new Error(`no email to ${address} within 5s`)
            await new Promise(resolve => setTimeout(resolve, 50))
        }
    }

    test("answers its health check", async () => {
        const res = await fetch(`${base}/health`)
        expect(await res.json()).toEqual({ status: "ok" })
    })

    test("signs a person up, verifies their email, and issues a JWT the API can check", async () => {
        const email = "owner@contractor.example"
        const password = "correct horse battery staple"

        const signUp = await post("/api/auth/sign-up/email", { name: "Owner", email, password })
        expect(signUp.status).toBe(200)

        // Not verified yet: signing in is refused, with the email sent again
        const early = await post("/api/auth/sign-in/email", { email, password })
        expect(early.status).toBe(403)

        const verification = await emailTo(email)
        expect(verification.subject).toBe("Verify your email address")
        const link = verification.text.match(/https?:\/\/\S+/)![0]

        // Verifying signs them in (autoSignInAfterVerification): the session cookie comes back
        const verified = await fetch(link, { redirect: "manual" })
        expect(verified.status).toBeLessThan(400)
        const cookie = verified.headers
            .getSetCookie()
            .map(c => c.split(";")[0])
            .join("; ")
        expect(cookie).toMatch(/better-auth\.session_token=/)

        const tokenResponse = await fetch(`${base}/api/auth/token`, { headers: { Cookie: cookie } })
        expect(tokenResponse.status).toBe(200)
        const { token } = (await tokenResponse.json()) as { token: string }

        const { payload, protectedHeader } = await jwtVerify(token, createRemoteJWKSet(new URL(`${base}/api/auth/jwks`)), {
            issuer: base,
            audience: base
        })
        expect(protectedHeader.alg).toBe("EdDSA")
        expect(payload.email).toBe(email)
        expect(payload.email_verified).toBe(true)
        expect(payload.sub).toMatch(/\S+/)
        expect(payload.exp! - payload.iat!).toBe(15 * 60)
    })

    test("refuses a browser request with cookies from an origin it doesn't trust, and a redirect to one", async () => {
        // Better Auth checks the Origin when the request carries cookies (its CSRF protection)
        const withCookie = await post(
            "/api/auth/sign-in/email",
            { email: "x@example.com", password: "a long enough password" },
            { Origin: "https://evil.example", Cookie: "better-auth.session_token=anything" }
        )
        expect(withCookie.status).toBe(403)
        // and only sends people back to a trusted origin
        const redirect = await post("/api/auth/sign-up/email", {
            name: "X",
            email: "x@example.com",
            password: "a long enough password",
            callbackURL: "https://evil.example/welcome"
        })
        expect(redirect.status).toBe(403)
    })
})
