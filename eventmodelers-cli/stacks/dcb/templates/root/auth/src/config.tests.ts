import { describe, expect, test } from "vitest"
import { loadConfig } from "./config.js"

const common = {
    BETTER_AUTH_SECRET: "a-secret-of-at-least-32-characters-long",
    DATABASE_URL: "postgresql://dcb:dcb@localhost:5432/dcb",
    EMAIL_FROM: "no-reply@example.com"
}
const onPremises = { ...common, DEPLOYMENT: "on-premises", BETTER_AUTH_URL: "http://localhost:5173", SMTP_URL: "smtp://mailpit:1025" }
const cloud = { ...common, DEPLOYMENT: "cloud", BETTER_AUTH_URL: "https://app.example.com", AWS_REGION: "eu-west-2" }

describe("the sign-in service's settings, by deployment (ADR-055)", () => {
    test("on-premises: SMTP, cookies secure only over https, the client IP from the reverse proxy", () => {
        const config = loadConfig(onPremises)
        expect(config.email.transport).toEqual({ kind: "smtp", url: "smtp://mailpit:1025" })
        expect(config.secureCookies).toBe(false)
        expect(config.ipAddressHeaders).toEqual(["x-forwarded-for"])
        expect(config.trustedOrigins).toEqual(["http://localhost:5173"])
        expect(config.port).toBe(3001)
        expect(loadConfig({ ...onPremises, BETTER_AUTH_URL: "https://auth.customer.example" }).secureCookies).toBe(true)
    })

    test("cloud: SES with the task's role, cookies always secure, the client IP set at the edge", () => {
        const config = loadConfig(cloud)
        expect(config.email.transport).toEqual({ kind: "ses", region: "eu-west-2" })
        expect(config.secureCookies).toBe(true)
        expect(config.ipAddressHeaders).toEqual(["x-client-ip"])
        expect(config.trustedOrigins).toEqual(["https://app.example.com"])
    })

    test("each default can be overridden on its own", () => {
        const config = loadConfig({
            ...cloud,
            EMAIL_TRANSPORT: "smtp",
            SMTP_URL: "smtps://user:pass@smtp.example.com:465",
            AUTH_IP_HEADERS: "x-forwarded-for",
            AUTH_TRUSTED_PROXIES: "10.0.0.0/24, 10.0.1.0/24",
            AUTH_TRUSTED_ORIGINS: "https://app.example.com,https://admin.example.com"
        })
        expect(config.email.transport.kind).toBe("smtp")
        expect(config.ipAddressHeaders).toEqual(["x-forwarded-for"])
        expect(config.trustedProxies).toEqual(["10.0.0.0/24", "10.0.1.0/24"])
        expect(config.trustedOrigins).toEqual(["https://app.example.com", "https://admin.example.com"])
    })

    test("a missing or bad setting stops it, naming every problem", () => {
        expect(() => loadConfig({ ...onPremises, DEPLOYMENT: undefined, BETTER_AUTH_SECRET: "short" })).toThrow(
            /DEPLOYMENT[\s\S]*BETTER_AUTH_SECRET: must be at least 32 characters/
        )
        expect(() => loadConfig({ ...onPremises, SMTP_URL: undefined })).toThrow(/SMTP_URL: required/)
        expect(() => loadConfig({ ...cloud, AWS_REGION: undefined })).toThrow(/AWS_REGION: required/)
    })
})
