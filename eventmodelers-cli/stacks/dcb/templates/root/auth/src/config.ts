import { z } from "zod"

/**
 * The sign-in service's settings, from the environment (ADR-055). `DEPLOYMENT` picks the defaults that differ between
 * our cloud and an on-premises install (locally and in CI it's on-premises, ADR-054); each can still be overridden on
 * its own. A required setting that's missing stops the service at startup, with every problem listed.
 *
 *   setting              cloud                         on-premises
 *   email                SES (the task's IAM role)     SMTP (`SMTP_URL`; Mailpit locally)
 *   secure cookies       always                        when BETTER_AUTH_URL is https
 *   client IP header     x-client-ip (set at the edge) x-forwarded-for (from the install's reverse proxy)
 */
export type Deployment = "cloud" | "on-premises"

export type EmailTransport = { kind: "smtp"; url: string } | { kind: "ses"; region: string }

export interface AuthConfig {
    deployment: Deployment
    /** Where `/api/auth` is served to the browser: the web app's own origin (the cookie stays first-party) */
    baseURL: string
    secret: string
    databaseUrl: string
    port: number
    /** Origins allowed to call sign-in from a browser: the web app's origin by default */
    trustedOrigins: string[]
    email: { from: string; transport: EmailTransport }
    secureCookies: boolean
    /** Headers holding the client's IP (rate limits, sessions): single-value unless `trustedProxies` is set */
    ipAddressHeaders: string[]
    /** The reverse proxies in front of the service (IPs or CIDR ranges), so a forwarded chain can be walked */
    trustedProxies: string[] | undefined
}

const list = (value: string | undefined) =>
    value
        ?.split(",")
        .map(v => v.trim())
        .filter(Boolean)

const Env = z.object({
    DEPLOYMENT: z.enum(["cloud", "on-premises"]),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -base64 32)"),
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(3001),
    EMAIL_FROM: z.string().min(1),
    EMAIL_TRANSPORT: z.enum(["smtp", "ses"]).optional(),
    SMTP_URL: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AUTH_TRUSTED_ORIGINS: z.string().optional(),
    AUTH_SECURE_COOKIES: z.enum(["true", "false"]).optional(),
    AUTH_IP_HEADERS: z.string().optional(),
    AUTH_TRUSTED_PROXIES: z.string().optional()
})

export function loadConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
    const parsed = Env.safeParse(env)
    if (!parsed.success) {
        const problems = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`)
        throw new Error(`The sign-in service's settings are incomplete:\n  ${problems.join("\n  ")}`)
    }
    const e = parsed.data
    const cloud = e.DEPLOYMENT === "cloud"

    const kind = e.EMAIL_TRANSPORT ?? (cloud ? "ses" : "smtp")
    let transport: EmailTransport
    if (kind === "ses") {
        if (!e.AWS_REGION) throw new Error("The sign-in service's settings are incomplete:\n  AWS_REGION: required to send email with SES")
        transport = { kind, region: e.AWS_REGION }
    } else {
        if (!e.SMTP_URL) throw new Error("The sign-in service's settings are incomplete:\n  SMTP_URL: required to send email over SMTP")
        transport = { kind, url: e.SMTP_URL }
    }

    return {
        deployment: e.DEPLOYMENT,
        baseURL: e.BETTER_AUTH_URL,
        secret: e.BETTER_AUTH_SECRET,
        databaseUrl: e.DATABASE_URL,
        port: e.PORT,
        trustedOrigins: list(e.AUTH_TRUSTED_ORIGINS) ?? [new URL(e.BETTER_AUTH_URL).origin],
        email: { from: e.EMAIL_FROM, transport },
        secureCookies: e.AUTH_SECURE_COOKIES ? e.AUTH_SECURE_COOKIES === "true" : cloud || e.BETTER_AUTH_URL.startsWith("https://"),
        ipAddressHeaders: list(e.AUTH_IP_HEADERS) ?? [cloud ? "x-client-ip" : "x-forwarded-for"],
        trustedProxies: list(e.AUTH_TRUSTED_PROXIES)
    }
}
