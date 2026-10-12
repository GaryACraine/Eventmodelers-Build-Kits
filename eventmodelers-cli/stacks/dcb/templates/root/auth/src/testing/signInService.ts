import { createServer as createHttpServer } from "node:http"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { runner } from "node-pg-migrate"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { authPool, createAuth } from "../auth.js"
import { loadConfig } from "../config.js"
import type { Email, SendEmail } from "../email.js"
import { createServer } from "../server.js"

/**
 * The sign-in service for tests: a real Postgres with the migrations, the service on a free port, its emails captured,
 * and browsers that keep their cookies. Have I Been Pwned is off (an internet call); `env` overrides any setting.
 */
export async function startSignInService({ env = {}, sendEmail }: { env?: Record<string, string>; sendEmail?: SendEmail } = {}) {
    const postgres = await new PostgreSqlContainer("postgres:18.6").start()
    await runner({
        databaseUrl: postgres.getConnectionUri(),
        dir: fileURLToPath(new URL("../../migrations", import.meta.url)),
        direction: "up",
        migrationsTable: "pgmigrations",
        schema: "auth",
        createSchema: true,
        migrationsSchema: "auth",
        createMigrationsSchema: true,
        log: () => {}
    })
    const http = createHttpServer()
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve)) // 127.0.0.1 only: on every address, another program on 127.0.0.1 could answer it (see the backend's src/test/loopback.ts)
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    const config = loadConfig({
        DEPLOYMENT: "on-premises",
        BETTER_AUTH_URL: base,
        BETTER_AUTH_SECRET: "a-secret-of-at-least-32-characters-long",
        DATABASE_URL: postgres.getConnectionUri(),
        EMAIL_FROM: "no-reply@example.com",
        SMTP_URL: "smtp://unused:1025",
        AUTH_BREACHED_PASSWORDS: "false",
        ...env
    })
    const pool = authPool(config.databaseUrl)
    const sent: Email[] = []
    http.on("request", createServer(createAuth(config, sendEmail ?? (async email => void sent.push(email)), pool)))

    let browsers = 0
    /**
     * A browser: its cookies, kept across requests, sent from the service's own origin, from its own address (the
     * rate limits are per address and path, so tests don't slow each other down)
     */
    function browser() {
        const jar = new Map<string, string>()
        const address = `10.0.${Math.floor(++browsers / 250)}.${browsers % 250}`
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
            return { status: response.status, body, location: response.headers.get("location"), retryAfter: response.headers.get("x-retry-after") }
        }
        return {
            address,
            request,
            /** Open a link from an email (it points at the service) */
            open: (link: string) => {
                const url = new URL(link)
                return request(`${url.pathname.replace(/^\/api\/auth/, "")}${url.search}`)
            },
            /** The token our API would get for this browser's session, or undefined when it has none */
            async token(): Promise<Record<string, unknown> | undefined> {
                const issued = await request("/token")
                if (issued.status !== 200) return undefined
                const { payload } = await jwtVerify(issued.body.token, createRemoteJWKSet(new URL(`${base}/api/auth/jwks`)), {
                    issuer: base,
                    audience: base
                })
                return payload
            },
            /** The factors in that token */
            async amr(): Promise<string[]> {
                const payload = await this.token()
                if (!payload) throw new Error("this browser has no session")
                return payload["amr"] as string[]
            },
            signOut: () => request("/sign-out", { body: {} })
        }
    }

    /** The last email to `to` with `subject`, sent after `after`: waits with a deadline (emails aren't awaited) */
    async function lastEmail(to: string, subject: string, after = 0): Promise<Email> {
        const deadline = Date.now() + 5_000
        for (;;) {
            const found = sent.slice(after).filter(e => e.to === to && e.subject === subject)
            if (found.length) return found[found.length - 1]!
            if (Date.now() > deadline) throw new Error(`no "${subject}" to ${to} within 5s`)
            await new Promise(resolve => setTimeout(resolve, 50))
        }
    }

    const linkIn = (email: Email) => email.text.match(/https?:\/\/\S+/)![0]

    const password = "correct horse battery staple"

    /** Sign up and open the verification link: the browser is then signed in */
    async function verifiedPerson(email: string, b = browser()) {
        const signedUp = await b.request("/sign-up/email", { body: { name: email, email, password } })
        if (signedUp.status !== 200) throw new Error(`sign up ${email}: ${signedUp.status}`)
        await b.open(linkIn(await lastEmail(email, "Verify your email address")))
        return b
    }

    /** Sign in with the password, then the code from the email */
    async function signInWithEmailedCode(email: string, b = browser(), { trustDevice = false, pass = password } = {}) {
        const first = await b.request("/sign-in/email", { body: { email, password: pass } })
        if (!first.body.twoFactorRedirect) throw new Error(`sign in ${email}: ${first.status} ${JSON.stringify(first.body)}`)
        const before = sent.length
        await b.request("/two-factor/send-otp", { body: {} })
        const code = (await lastEmail(email, "Your sign-in code", before)).text.match(/\b\d{6}\b/)![0]
        const verified = await b.request("/two-factor/verify-otp", { body: { code, trustDevice } })
        if (verified.status !== 200) throw new Error(`code for ${email}: ${verified.status}`)
        return b
    }

    async function stop() {
        await new Promise(resolve => http.close(resolve))
        await pool.end()
        await postgres.stop()
    }

    return { base, pool, sent, password, browser, lastEmail, linkIn, verifiedPerson, signInWithEmailedCode, stop }
}

export type SignInService = Awaited<ReturnType<typeof startSignInService>>
