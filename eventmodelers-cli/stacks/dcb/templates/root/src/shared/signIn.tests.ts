import { describe, test, expect, beforeAll } from "vitest"
import supertest from "supertest"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose"
import { getApplication } from "@dcb-es/event-store-express"
import { configureSignIn, readModelLookup, requirePermission, requireSession, sessionOf, signedInOf, signInSettings, type SignInSettings } from "./signIn.js"

// Tokens as the sign-in service issues them (Better Auth's JWT plugin: EdDSA, `sub`, `email`, `email_verified`),
// signed here with a key of our own and checked against a JWKS holding it
const issuer = "http://localhost:5173"

describe("the API's sign-in check (ADR-037, ADR-055)", () => {
    let key: CryptoKey
    let settings: SignInSettings

    beforeAll(async () => {
        const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
        key = pair.privateKey
        const jwk = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
        settings = { issuer, audience: issuer, jwks: createLocalJWKSet({ keys: [jwk] }) }
    })

    const token = (claims: Record<string, unknown> = {}, options: { issuer?: string; expiresIn?: string; signWith?: CryptoKey } = {}) =>
        new SignJWT({ email: "owner@contractor.example", email_verified: true, ...claims })
            .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
            .setSubject("sub-7f3a")
            .setIssuer(options.issuer ?? issuer)
            .setAudience(issuer)
            .setIssuedAt()
            .setExpirationTime(options.expiresIn ?? "15m")
            .sign(options.signWith ?? key)

    /** `null`: sign-in not configured */
    // The session lookup: our userId for a registered sub (licensing: My Account)
    const lookup = readModelLookup(async sub => (sub === "sub-7f3a" ? { sub, userId: "user-1", email: "owner@contractor.example" } : null))

    const agent = (configured: SignInSettings | null = settings) =>
        supertest(
            getApplication({
                apis: [
                    configureSignIn({ settings: configured ?? undefined, lookup }),
                    router => router.get("/who", (_req, res) => void res.json(signedInOf(res) ?? null)),
                    router => router.get("/mine", requireSession(["sub", "email"]), (req, res) => void res.json(sessionOf(req))),
                    router => router.post("/act", requireSession(["userId"]), (req, res) => void res.json(sessionOf(req))),
                    router => router.post("/assign", requirePermission("seat:assign", ["userId"]), (req, res) => void res.json(sessionOf(req)))
                ]
            })
        )

    test("a request without a token passes, with no one signed in", async () => {
        const res = await agent().get("/who")
        expect(res.status).toBe(200)
        expect(res.body).toBeNull()
    })

    test("a valid token says who is signed in", async () => {
        const res = await agent().get("/who").set("Authorization", `Bearer ${await token()}`)
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ sub: "sub-7f3a", email: "owner@contractor.example" })
    })

    test.each([
        ["expired", () => token({}, { expiresIn: "-1m" })],
        ["from another issuer", () => token({}, { issuer: "https://elsewhere.example" })],
        ["with an unverified email", () => token({ email_verified: false })],
        ["signed with another key", async () => token({}, { signWith: (await generateKeyPair("EdDSA", { crv: "Ed25519" })).privateKey })],
        ["tampered with", async () => (await token()).replace(/\.([^.]+)\./, (_, body: string) => `.${body.slice(0, -2)}xx.`)]
    ])("a token %s is refused with 401, and the route doesn't run", async (_, make) => {
        const res = await agent().get("/who").set("Authorization", `Bearer ${await make()}`)
        expect(res.status).toBe(401)
        expect(res.headers["content-type"]).toContain("application/problem+json")
        expect(res.headers["www-authenticate"]).toContain("Bearer")
    })

    test("an Authorization header that isn't a bearer token is refused", async () => {
        const res = await agent().get("/who").set("Authorization", "Basic dXNlcjpwYXNz")
        expect(res.status).toBe(401)
    })

    test("when sign-in isn't configured, any token is refused rather than trusted", async () => {
        const res = await agent(null).get("/who").set("Authorization", `Bearer ${await token()}`)
        expect(res.status).toBe(401)
        expect(res.body.detail).toMatch(/isn't configured/)
    })

    test("settings come from the environment, the audience defaulting to the issuer", () => {
        expect(signInSettings({})).toBeUndefined()
        const configured = signInSettings({ AUTH_ISSUER: issuer, AUTH_JWKS_URL: "http://auth:3001/api/auth/jwks" })
        expect(configured).toMatchObject({ issuer, audience: issuer })
    })

    test("a route that needs the signed-in person refuses a request without a token (401)", async () => {
        const res = await agent().get("/mine")
        expect(res.status).toBe(401)
        expect(res.headers["www-authenticate"]).toContain("Bearer")
    })

    test("the signed-in person's sub and email come from the token, never the request", async () => {
        const res = await agent().get("/mine?sub=someone-else").set("Authorization", `Bearer ${await token()}`).send({ sub: "someone-else" })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ sub: "sub-7f3a", email: "owner@contractor.example" })
    })

    test("a key the token doesn't hold comes from the session lookup", async () => {
        const res = await agent().post("/act").set("Authorization", `Bearer ${await token()}`).send({ userId: "forged" })
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ sub: "sub-7f3a", userId: "user-1" })
    })

    test("a route with a permission refuses a request without a token (401), and runs for a signed-in person", async () => {
        expect((await agent().post("/assign")).status).toBe(401)
        // ADR-060: the role check joins in 2b.2f step 4; until then a permission route needs sign-in (and its keys)
        const res = await agent().post("/assign").set("Authorization", `Bearer ${await token()}`)
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ userId: "user-1" })
    })

    test("signed in but not registered: 403, register first", async () => {
        const stranger = await new SignJWT({ email: "new@example.com", email_verified: true })
            .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
            .setSubject("sub-new")
            .setIssuer(issuer)
            .setAudience(issuer)
            .setIssuedAt()
            .setExpirationTime("15m")
            .sign(key)
        const res = await agent().post("/act").set("Authorization", `Bearer ${stranger}`)
        expect(res.status).toBe(403)
        expect(res.body.detail).toMatch(/Register first: there's no userId/)
    })
})
