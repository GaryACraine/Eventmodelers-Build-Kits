import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { factorsInToken } from "./signInMethod.js"
import { softwarePasskey, totpCode } from "./testing/softwarePasskey.js"
import { startSignInService, type SignInService } from "./testing/signInService.js"
import { removeUnverifiedAccounts } from "./unverified.js"

/**
 * The account's security lifecycle (ADR-056, the "Decided" table), against the real service on Postgres: a reset (D4),
 * changing the password (D5) and the email (D6), password rules (D7), sessions (D9), notices (D10), abuse (D11),
 * sign-up's unhappy paths (D12) and how long a step-up lasts (D15). Emails are captured; each test is its own person.
 */
describe("the account's security lifecycle (ADR-056)", () => {
    let service: SignInService
    beforeAll(async () => {
        service = await startSignInService()
    })
    afterAll(async () => {
        await service?.stop()
    })

    const subjectsTo = (to: string, after = 0) => service.sent.slice(after).filter(e => e.to === to).map(e => e.subject)

    describe("D4: a forgotten password", () => {
        test("an emailed link, once, that ends every session; the same answer for an address with no account", async () => {
            const email = "reset@example.com"
            const signedIn = await service.verifiedPerson(email)
            const b = service.browser()

            const asked = await b.request("/request-password-reset", { body: { email, redirectTo: "/reset-password" } })
            const unknown = await service.browser().request("/request-password-reset", { body: { email: "nobody@example.com", redirectTo: "/reset-password" } })
            expect([asked.status, asked.body]).toEqual([unknown.status, unknown.body])

            const opened = await b.open(service.linkIn(await service.lastEmail(email, "Reset your password")))
            const token = new URL(opened.location!, service.base).searchParams.get("token")!
            expect(token).toBeTruthy()
            expect((await b.request("/reset-password", { body: { token, newPassword: "a brand new long password" } })).status).toBe(200)
            expect((await b.request("/reset-password", { body: { token, newPassword: "and again, a second time" } })).status).toBe(400)

            expect(await signedIn.token()).toBeUndefined()
            await service.lastEmail(email, "Your password was reset")
            await service.signInWithEmailedCode(email, service.browser(), { pass: "a brand new long password" })
        })
    })

    describe("D5: changing the password", () => {
        test("needs the current one, and ends every other session even when the form asks not to", async () => {
            const email = "change@example.com"
            await service.verifiedPerson(email)
            const other = await service.signInWithEmailedCode(email)
            const b = await service.signInWithEmailedCode(email)

            const wrong = await b.request("/change-password", { body: { currentPassword: "not my password at all", newPassword: "a brand new long password" } })
            expect(wrong.status).toBe(400)
            const changed = await b.request("/change-password", {
                body: { currentPassword: service.password, newPassword: "a brand new long password", revokeOtherSessions: false }
            })
            expect(changed.status).toBe(200)

            expect(await other.token()).toBeUndefined()
            expect(await b.amr()).toEqual(["pwd", "email-otp"])
            await service.lastEmail(email, "Your password was changed")
        })
    })

    describe("D6: changing the email", () => {
        test("confirmed at the old address, verified at the new one, the old one told; the links sign no one in", async () => {
            const from = "old-address@example.com"
            const to = "new-address@example.com"
            await service.verifiedPerson(from)
            const b = await service.signInWithEmailedCode(from)

            expect((await b.request("/change-email", { body: { newEmail: to, callbackURL: "/" } })).status).toBe(200)
            const elsewhere = service.browser()
            await elsewhere.open(service.linkIn(await service.lastEmail(from, "Confirm the change of your email address")))
            await elsewhere.open(service.linkIn(await service.lastEmail(to, "Verify your email address")))

            const user = await service.pool.query(`select email, "emailVerified" from "user" where email = $1`, [to])
            expect(user.rows).toEqual([{ email: to, emailVerified: true }])
            const told = await service.lastEmail(from, "Your email address was changed")
            expect(told.text).toContain(to)
            // Opening the links signed the other browser in with nothing proved, or not at all
            expect((await elsewhere.token())?.["amr"] ?? []).toEqual([])
            expect((await b.token())?.["email"]).toBe(to)
        })
    })

    describe("D7: password rules", () => {
        test("at least 12 characters, at most 128, no composition rules", async () => {
            const b = service.browser()
            const tooShort = await b.request("/sign-up/email", { body: { name: "x", email: "short@example.com", password: "elevenchars" } })
            expect(tooShort.status).toBe(400)
            const tooLong = await b.request("/sign-up/email", { body: { name: "x", email: "long@example.com", password: "x".repeat(129) } })
            expect(tooLong.status).toBe(400)
            const plain = await b.request("/sign-up/email", { body: { name: "x", email: "plain@example.com", password: "twelve chars" } })
            expect(plain.status).toBe(200)
        })
    })

    describe("D9: sessions", () => {
        test("last 7 days; the person sees them and can sign out everywhere", async () => {
            const email = "sessions@example.com"
            await service.verifiedPerson(email)
            const phone = await service.signInWithEmailedCode(email)
            const laptop = await service.signInWithEmailedCode(email)

            const listed = await laptop.request("/list-sessions")
            expect(listed.body.length).toBeGreaterThanOrEqual(2)
            const days = (new Date(listed.body[0].expiresAt).getTime() - Date.now()) / 86_400_000
            expect(days).toBeGreaterThan(6.9)
            expect(days).toBeLessThanOrEqual(7)

            expect((await laptop.request("/revoke-other-sessions", { body: {} })).status).toBe(200)
            expect(await phone.token()).toBeUndefined()
            expect(await laptop.token()).toBeDefined()
        })
    })

    describe("D10: security notices", () => {
        test("a sign-in from a new device is told, a known device isn't, and the first sign-in by the link isn't", async () => {
            const email = "devices@example.com"
            const first = await service.verifiedPerson(email)
            expect(subjectsTo(email)).not.toContain("A new sign-in to your account")

            let mark = service.sent.length
            await first.signOut()
            await service.signInWithEmailedCode(email, first)
            expect(subjectsTo(email, mark)).not.toContain("A new sign-in to your account")

            mark = service.sent.length
            await service.signInWithEmailedCode(email)
            await service.lastEmail(email, "A new sign-in to your account", mark)
        })

        test("setting up the app, new backup codes, a backup code used, the app removed (the emailed code comes back)", async () => {
            const email = "factors@example.com"
            await service.verifiedPerson(email)
            const b = await service.signInWithEmailedCode(email)
            const enabled = await b.request("/two-factor/enable", { body: { password: service.password } })
            const secret = new URL(enabled.body.totpURI).searchParams.get("secret")!
            const backupCodes = enabled.body.backupCodes as string[]
            await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })
            await service.lastEmail(email, "An authenticator app was set up")

            const c = service.browser()
            await c.request("/sign-in/email", { body: { email, password: service.password } })
            expect((await c.request("/two-factor/verify-backup-code", { body: { code: backupCodes[0] } })).status).toBe(200)
            expect(await c.amr()).toEqual(["pwd", "backup-code"])
            await service.lastEmail(email, "A backup code was used")

            expect((await c.request("/two-factor/generate-backup-codes", { body: { password: service.password } })).status).toBe(200)
            await service.lastEmail(email, "New backup codes were made")

            expect((await c.request("/two-factor/disable", { body: { password: service.password } })).status).toBe(200)
            await service.lastEmail(email, "Your authenticator app was removed")
            const after = service.browser()
            expect((await after.request("/sign-in/email", { body: { email, password: service.password } })).body).toMatchObject({
                twoFactorRedirect: true,
                twoFactorMethods: ["otp"]
            })
        })

        test("a passkey added and removed", async () => {
            const email = "passkey-notices@example.com"
            await service.verifiedPerson(email)
            const b = await service.signInWithEmailedCode(email)
            const key = softwarePasskey(service.base)
            const options = await b.request("/passkey/generate-register-options")
            const added = await b.request("/passkey/verify-registration", { body: { response: key.register(options.body) } })
            expect(added.status).toBe(200)
            await service.lastEmail(email, "A passkey was added")

            // Removing it needs the passkey itself (the strongest factor this person has)
            const c = service.browser()
            const challenge = await c.request("/passkey/generate-authenticate-options")
            await c.request("/passkey/verify-authentication", { body: { response: key.authenticate(challenge.body) } })
            expect((await b.request("/passkey/delete-passkey", { body: { id: added.body.id } })).status).toBe(403)
            expect((await c.request("/passkey/delete-passkey", { body: { id: added.body.id } })).status).toBe(200)
            await service.lastEmail(email, "A passkey was removed")
        })
    })

    describe("D11: abuse", () => {
        test("five password attempts a minute from one address, then 429", async () => {
            const b = service.browser()
            const statuses: number[] = []
            for (let i = 0; i < 6; i++)
                statuses.push((await b.request("/sign-in/email", { body: { email: "flood@example.com", password: "a wrong password, again" } })).status)
            expect(statuses.slice(0, 5)).not.toContain(429)
            expect(statuses[5]).toBe(429)
        })
    })

    describe("D12: sign-up's unhappy paths", () => {
        test("signing up again looks the same as a new sign-up; a verified owner is told, an unverified one gets the link again", async () => {
            const verified = "twice@example.com"
            await service.verifiedPerson(verified)
            const fresh = await service.browser().request("/sign-up/email", { body: { name: "n", email: "brand-new@example.com", password: service.password } })
            const again = await service.browser().request("/sign-up/email", { body: { name: "n", email: verified, password: service.password } })
            expect(again.status).toBe(fresh.status)
            expect(Object.keys(again.body.user).sort()).toEqual(Object.keys(fresh.body.user).sort())
            await service.lastEmail(verified, "You already have an account")

            const mark = service.sent.length
            await service.browser().request("/sign-up/email", { body: { name: "n", email: "brand-new@example.com", password: service.password } })
            await service.lastEmail("brand-new@example.com", "Verify your email address", mark)
        })

        test("accounts never verified are removed after the retention; verified and recent ones stay", async () => {
            await service.browser().request("/sign-up/email", { body: { name: "n", email: "stale@example.com", password: service.password } })
            await service.browser().request("/sign-up/email", { body: { name: "n", email: "recent@example.com", password: service.password } })
            await service.verifiedPerson("kept@example.com")
            await service.pool.query(`update "user" set "createdAt" = now() - interval '8 days' where email in ('stale@example.com', 'kept@example.com')`)

            expect(await removeUnverifiedAccounts(service.pool, 7)).toBeGreaterThanOrEqual(1)
            const left = await service.pool.query(`select email from "user" where email in ('stale@example.com', 'recent@example.com', 'kept@example.com') order by email`)
            expect(left.rows.map(r => r.email)).toEqual(["kept@example.com", "recent@example.com"])
        })
    })

    describe("D15: a step-up lasts 12 hours", () => {
        test("after 12 hours the token stops listing the app, so the API asks again; the session itself goes on", async () => {
            const email = "twelve-hours@example.com"
            await service.verifiedPerson(email)
            const b = await service.signInWithEmailedCode(email)
            const secret = new URL((await b.request("/two-factor/enable", { body: { password: service.password } })).body.totpURI).searchParams.get("secret")!
            await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })
            await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })
            expect(await b.amr()).toEqual(["pwd", "email-otp", "totp"])

            await service.pool.query(`update session set "strongAt" = now() - interval '13 hours' where "userId" = (select id from "user" where email = $1)`, [email])
            expect(await b.amr()).toEqual(["pwd", "email-otp"])
        })

        test("factorsInToken keeps the inbox's factors and drops the others once the hours have passed", () => {
            const at = Date.UTC(2026, 9, 11, 12)
            const session = { userId: "u", amr: "pwd email-otp totp", strongAt: new Date(at) }
            expect(factorsInToken(session, 12, at + 11 * 3_600_000)).toEqual(["pwd", "email-otp", "totp"])
            expect(factorsInToken(session, 12, at + 12 * 3_600_000)).toEqual(["pwd", "email-otp"])
            expect(factorsInToken({ userId: "u", amr: "passkey" }, 12, at)).toEqual([])
        })
    })
})

describe("an email that can't be sent (D12)", () => {
    test("is an alert line in the log, without the address", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {})
        const service = await startSignInService({ sendEmail: async () => Promise.reject(new Error("SMTP is down")) })
        try {
            await service.browser().request("/sign-up/email", { body: { name: "n", email: "unsent@example.com", password: service.password } })
            const deadline = Date.now() + 5_000
            let line: string | undefined
            while (!line && Date.now() < deadline) {
                line = errors.mock.calls.map(c => String(c[0])).find(l => l.includes('"sign-in-email-failed"'))
                if (!line) await new Promise(resolve => setTimeout(resolve, 50))
            }
            expect(JSON.parse(line!)).toMatchObject({ level: "alert", code: "sign-in-email-failed", severity: "warning" })
            expect(line).not.toContain("unsent@example.com")
        } finally {
            errors.mockRestore()
            await service.stop()
        }
    })
})
