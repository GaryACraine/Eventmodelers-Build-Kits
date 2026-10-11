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
import { softwarePasskey, totpCode } from "./testing/softwarePasskey.js"

/**
 * How each session signed in reaches the token as `amr` (ADR-056 D1), on a real Postgres with the migrations: the
 * verification link, the password with an emailed code (D2), a trusted device, the authenticator app, and a passkey.
 * Proving a factor while enrolling it never makes a session stronger, and a session that only proved the inbox can't
 * change the factors of someone who has a stronger one. Emails are captured.
 */
describe("how a session signed in (amr)", () => {
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
        base = `http://localhost:${(http.address() as { port: number }).port}`
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

    let browsers = 0
    /**
     * A browser: its cookies, kept across requests, sent from the service's own origin, from its own address (the
     * plugin's rate limit, 3 per 10 s per address and path, would otherwise slow the tests)
     */
    function browser() {
        const jar = new Map<string, string>()
        const address = `10.0.0.${++browsers}`
        const request = async (path: string, init: { method?: string; body?: unknown } = {}) => {
            const response = await fetch(`${base}/api/auth${path}`, {
                method: init.method ?? (init.body === undefined ? "GET" : "POST"),
                redirect: "manual",
                headers: {
                    Origin: base,
                    "X-Forwarded-For": address,
                    ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
                    ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {})
                },
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
            })
            for (const c of response.headers.getSetCookie()) {
                const [pair, ...attributes] = c.split(";")
                const [name, ...value] = pair!.split("=")
                if (attributes.some(a => /max-age=0\b/i.test(a.trim()))) jar.delete(name!.trim())
                else jar.set(name!.trim(), value.join("="))
            }
            const text = await response.text()
            let body: any = {}
            try {
                body = JSON.parse(text)
            } catch {}
            return { status: response.status, body }
        }
        return {
            request,
            /** The factors in the token our API would get for this browser's session */
            async amr(): Promise<string[]> {
                const issued = await request("/token")
                expect(issued.status).toBe(200)
                const { payload } = await jwtVerify(issued.body.token, createRemoteJWKSet(new URL(`${base}/api/auth/jwks`)), {
                    issuer: base,
                    audience: base
                })
                return payload.amr as string[]
            },
            signOut: () => request("/sign-out", { body: {} })
        }
    }

    /** Wait on state with a deadline: emails are sent without being awaited */
    async function lastEmail(to: string, subject: string, after = 0): Promise<Email> {
        const deadline = Date.now() + 5_000
        for (;;) {
            const found = sent.slice(after).filter(e => e.to === to && e.subject === subject)
            if (found.length) return found[found.length - 1]!
            if (Date.now() > deadline) throw new Error(`no "${subject}" to ${to} within 5s`)
            await new Promise(resolve => setTimeout(resolve, 50))
        }
    }

    const password = "correct horse battery staple"

    async function verifiedPerson(email: string) {
        const b = browser()
        expect((await b.request("/sign-up/email", { body: { name: email, email, password } })).status).toBe(200)
        const link = (await lastEmail(email, "Verify your email address")).text.match(/https?:\/\/\S+/)![0]
        const url = new URL(link)
        await b.request(`${url.pathname.replace(/^\/api\/auth/, "")}${url.search}`)
        return b
    }

    /** Sign in with the password, then the code from the email */
    async function signInWithEmailedCode(email: string, b = browser(), trustDevice = false) {
        const first = await b.request("/sign-in/email", { body: { email, password } })
        expect(first.body.twoFactorRedirect).toBe(true)
        const before = sent.length
        expect((await b.request("/two-factor/send-otp", { body: {} })).status).toBe(200)
        const code = (await lastEmail(email, "Your sign-in code", before)).text.match(/\b\d{6}\b/)![0]
        expect((await b.request("/two-factor/verify-otp", { body: { code, trustDevice } })).status).toBe(200)
        return b
    }

    test("the verification link signs in with email-link, and turns the emailed code on (D2)", async () => {
        const b = await verifiedPerson("link@example.com")
        expect(await b.amr()).toEqual(["email-link"])
        const user = await pool.query(`select "twoFactorEnabled" from "user" where email = $1`, ["link@example.com"])
        expect(user.rows[0].twoFactorEnabled).toBe(true)
    })

    test("a password alone never signs in; with the emailed code it's pwd and email-otp", async () => {
        await verifiedPerson("code@example.com")
        const b = browser()
        const first = await b.request("/sign-in/email", { body: { email: "code@example.com", password } })
        expect(first.body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["otp"] })
        expect((await b.request("/token")).status).toBe(401)
        await signInWithEmailedCode("code@example.com", b)
        expect(await b.amr()).toEqual(["pwd", "email-otp"])
    })

    test("a trusted device skips the code, and says so", async () => {
        await verifiedPerson("trusted@example.com")
        const b = await signInWithEmailedCode("trusted@example.com", browser(), true)
        await b.signOut()
        const again = await b.request("/sign-in/email", { body: { email: "trusted@example.com", password } })
        expect(again.body.twoFactorRedirect).toBeUndefined()
        expect(await b.amr()).toEqual(["pwd", "trusted-device"])
    })

    test("setting up the app doesn't step up; its code afterwards does, and signing in with it says totp", async () => {
        const email = "app@example.com"
        await verifiedPerson(email)
        const b = await signInWithEmailedCode(email)
        const enabled = await b.request("/two-factor/enable", { body: { password } })
        expect(enabled.status).toBe(200)
        const secret = new URL(enabled.body.totpURI).searchParams.get("secret")!

        // Proving the code that sets the app up
        expect((await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })).status).toBe(200)
        expect(await b.amr()).toEqual(["pwd", "email-otp"])

        // The app, now set up, steps this session up
        expect((await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })).status).toBe(200)
        expect(await b.amr()).toEqual(["pwd", "email-otp", "totp"])

        // Signing in with it
        const c = browser()
        expect((await c.request("/sign-in/email", { body: { email, password } })).body.twoFactorMethods).toEqual(["totp", "otp"])
        expect((await c.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })).status).toBe(200)
        expect(await c.amr()).toEqual(["pwd", "totp"])
    })

    test("someone with the app can't change a factor from a session that only proved the inbox", async () => {
        const email = "guarded@example.com"
        await verifiedPerson(email)
        const owner = await signInWithEmailedCode(email)
        const secret = new URL((await owner.request("/two-factor/enable", { body: { password } })).body.totpURI).searchParams.get("secret")!
        await owner.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })

        // An attacker who has the password and the inbox, but not the app
        const attacker = await signInWithEmailedCode(email)
        expect(await attacker.amr()).toEqual(["pwd", "email-otp"])
        for (const [path, body] of [
            ["/two-factor/disable", { password }],
            ["/two-factor/enable", { password }],
            ["/two-factor/generate-backup-codes", { password }]
        ] as const) {
            const refused = await attacker.request(path, { body })
            expect(refused.status, path).toBe(403)
            expect(refused.body.code, path).toBe("STRONGER_FACTOR_REQUIRED")
        }
        expect((await attacker.request("/passkey/generate-register-options")).status).toBe(403)
    })

    test("wrong app codes while signed in lock the account, as at sign-in", async () => {
        const email = "locked@example.com"
        await verifiedPerson(email)
        const b = await signInWithEmailedCode(email)
        const secret = new URL((await b.request("/two-factor/enable", { body: { password } })).body.totpURI).searchParams.get("secret")!
        await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })
        // Nine wrong already (the plugin's rate limit, 3 per 10 s, would make ten slow)
        await pool.query(`update "twoFactor" set "failedVerificationCount" = 9 where "userId" = (select id from "user" where email = $1)`, [email])
        const wrong = totpCode(secret) === "000000" ? "111111" : "000000"
        expect((await b.request("/two-factor/verify-totp", { body: { code: wrong } })).status).toBe(401)
        const locked = await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })
        expect(locked.status).toBe(429)
        expect(await b.amr()).toEqual(["pwd", "email-otp"])
    })

    test("a passkey that checks it's you signs in on its own; one that doesn't is refused", async () => {
        const email = "passkey@example.com"
        await verifiedPerson(email)
        const b = await signInWithEmailedCode(email)
        const key = softwarePasskey(base)

        // Registering doesn't sign anyone in
        const options = await b.request("/passkey/generate-register-options")
        expect(options.status).toBe(200)
        const refusedSession = await b.request("/passkey/verify-registration", {
            body: { response: key.register(options.body), createSession: true }
        })
        expect(refusedSession.status).toBe(400)

        // Without the device's own check (biometric or PIN), it isn't registered
        const again = await b.request("/passkey/generate-register-options")
        expect((await b.request("/passkey/verify-registration", { body: { response: key.register(again.body, { userVerified: false }) } })).status).toBe(400)

        const third = await b.request("/passkey/generate-register-options")
        expect((await b.request("/passkey/verify-registration", { body: { response: key.register(third.body), name: "Laptop" } })).status).toBe(200)
        expect(await b.amr()).toEqual(["pwd", "email-otp"])

        // Signing in with it, from a browser with no session
        const c = browser()
        const challenge = await c.request("/passkey/generate-authenticate-options")
        expect((await c.request("/passkey/verify-authentication", { body: { response: key.authenticate(challenge.body) } })).status).toBe(200)
        expect(await c.amr()).toEqual(["passkey"])

        // Without the device's check, refused
        const d = browser()
        const unverified = await d.request("/passkey/generate-authenticate-options")
        expect((await d.request("/passkey/verify-authentication", { body: { response: key.authenticate(unverified.body, { userVerified: false }) } })).status).toBe(401)
    })
})
