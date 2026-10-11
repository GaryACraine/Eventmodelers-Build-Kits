import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { softwarePasskey, totpCode } from "./testing/softwarePasskey.js"
import { startSignInService, type SignInService } from "./testing/signInService.js"

/**
 * How each session signed in reaches the token as `amr` (ADR-056 D1), on a real Postgres with the migrations: the
 * verification link, the password with an emailed code (D2), a trusted device, the authenticator app, and a passkey.
 * Proving a factor while enrolling it never makes a session stronger, the emailed code isn't offered once there's a
 * stronger factor (D4a), and a session that only proved the inbox can't change the factors. Emails are captured.
 */
describe("how a session signed in (amr)", () => {
    let service: SignInService
    beforeAll(async () => {
        service = await startSignInService()
    })
    afterAll(async () => {
        await service?.stop()
    })

    const browser = () => service.browser()
    const password = "correct horse battery staple"
    const verifiedPerson = (email: string) => service.verifiedPerson(email)
    const signInWithEmailedCode = (email: string, b = browser(), trustDevice = false) => service.signInWithEmailedCode(email, b, { trustDevice })

    test("the verification link signs in with email-link, and turns the emailed code on (D2)", async () => {
        const b = await verifiedPerson("link@example.com")
        expect(await b.amr()).toEqual(["email-link"])
        const user = await service.pool.query(`select "twoFactorEnabled" from "user" where email = $1`, ["link@example.com"])
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
        // What the web app reads to offer a step-up: only the signed-in person's own
        expect((await browser().request("/sign-in-method/factors")).status).toBe(401)
        expect((await b.request("/sign-in-method/factors")).body).toEqual({ app: false, passkeys: 0 })
        const enabled = await b.request("/two-factor/enable", { body: { password } })
        expect(enabled.status).toBe(200)
        const secret = new URL(enabled.body.totpURI).searchParams.get("secret")!
        expect((await b.request("/sign-in-method/factors")).body).toEqual({ app: false, passkeys: 0 })

        // Proving the code that sets the app up
        expect((await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })).status).toBe(200)
        expect(await b.amr()).toEqual(["pwd", "email-otp"])
        expect((await b.request("/sign-in-method/factors")).body).toEqual({ app: true, passkeys: 0 })

        // The app, now set up, steps this session up
        expect((await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })).status).toBe(200)
        expect(await b.amr()).toEqual(["pwd", "email-otp", "totp"])

        // Signing in with it: the emailed code is no longer offered (D4a)
        const c = browser()
        expect((await c.request("/sign-in/email", { body: { email, password } })).body.twoFactorMethods).toEqual(["totp"])
        expect((await c.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })).status).toBe(200)
        expect(await c.amr()).toEqual(["pwd", "totp"])
    })

    test("with the app, the inbox alone signs no one in (D4a), and an older session can't change a factor", async () => {
        const email = "guarded@example.com"
        await verifiedPerson(email)
        // A session from before the app was set up, on another device
        const older = await signInWithEmailedCode(email)
        const owner = await signInWithEmailedCode(email)
        const secret = new URL((await owner.request("/two-factor/enable", { body: { password } })).body.totpURI).searchParams.get("secret")!
        await owner.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })

        // An attacker who has the password and the inbox, but not the app, gets no session
        const attacker = browser()
        expect((await attacker.request("/sign-in/email", { body: { email, password } })).body.twoFactorMethods).toEqual(["totp"])
        const asked = await attacker.request("/two-factor/send-otp", { body: {} })
        expect(asked.status).toBe(403)
        expect(asked.body.code).toBe("EMAILED_CODE_NOT_OFFERED")
        expect((await attacker.request("/two-factor/verify-otp", { body: { code: "123456" } })).status).toBe(403)
        expect((await attacker.request("/token")).status).toBe(401)

        // The older session proved only the inbox: it can't add, remove or view a factor
        expect(await older.amr()).toEqual(["pwd", "email-otp"])
        for (const [path, body] of [
            ["/two-factor/disable", { password }],
            ["/two-factor/enable", { password }],
            ["/two-factor/generate-backup-codes", { password }]
        ] as const) {
            const refused = await older.request(path, { body })
            expect(refused.status, path).toBe(403)
            expect(refused.body.code, path).toBe("STRONGER_FACTOR_REQUIRED")
        }
        expect((await older.request("/passkey/generate-register-options")).status).toBe(403)
    })

    test("wrong app codes while signed in lock the account, as at sign-in", async () => {
        const email = "locked@example.com"
        await verifiedPerson(email)
        const b = await signInWithEmailedCode(email)
        const secret = new URL((await b.request("/two-factor/enable", { body: { password } })).body.totpURI).searchParams.get("secret")!
        await b.request("/two-factor/verify-totp", { body: { code: totpCode(secret) } })
        // Nine wrong already (the plugin's rate limit, 3 per 10 s, would make ten slow)
        await service.pool.query(`update "twoFactor" set "failedVerificationCount" = 9 where "userId" = (select id from "user" where email = $1)`, [email])
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
        const key = softwarePasskey(service.base)

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
