import { describe, test, expect, beforeAll } from "vitest"
import supertest from "supertest"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose"
import { getApplication } from "@dcb-es/event-store-express"
import { held, type RoleLookup, type RoleMap } from "./permissions.js"
import { configureSignIn, readModelLookup, requirePermission, requireSession, sessionOf, signedInOf, signInSettings, type SignInSettings } from "./signIn.js"

// Tokens as the sign-in service issues them (Better Auth's JWT plugin: EdDSA, `sub`, `email`, `email_verified`, and
// `amr`, how the session signed in: a password and an emailed code unless a test says otherwise), signed here with a
// key of our own and checked against a JWKS holding it
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
        new SignJWT({ email: "owner@contractor.example", email_verified: true, amr: ["pwd", "email-otp"], ...claims })
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

    // ADR-060: the role map, and the roles each caller holds (an owner of org-1, an engineer of org-3, an admin of
    // org-4, a platform admin). ADR-056 D3: the owner and the platform admin need the app or a passkey
    const roleMap: RoleMap = {
        tenantKey: "organisationId",
        roles: {
            owner: { scope: "organisation", permissions: ["seat:assign", "seat:read"], signIn: "not-by-email" },
            admin: { scope: "organisation", permissions: ["seat:read"], signIn: "second-factor" },
            engineer: { scope: "organisation", permissions: [] },
            platformAdmin: { scope: "platform", permissions: ["seat:read", "notification:list"], signIn: "not-by-email" }
        }
    }
    const roles: RoleLookup = async ({ sub, session }, organisation) => {
        if (sub === "sub-ops") return { platform: ["platformAdmin"], organisation: [] }
        const held: Record<string, string[]> =
            session.userId === "user-1" ? { "org-1": ["owner"], "org-3": ["engineer"], "org-4": ["owner", "admin"] } : {}
        return { platform: [], organisation: (organisation && held[organisation]) || [] }
    }

    const agent = (configured: SignInSettings | null = settings, access: { roles?: RoleLookup; roleMap?: RoleMap } = { roles, roleMap }) =>
        supertest(
            getApplication({
                apis: [
                    configureSignIn({ settings: configured ?? undefined, lookup, ...access }),
                    router => router.get("/who", (_req, res) => void res.json(signedInOf(res) ?? null)),
                    router => router.get("/mine", requireSession(["sub", "email"]), (req, res) => void res.json(sessionOf(req))),
                    router => router.post("/act", requireSession(["userId"]), (req, res) => void res.json(sessionOf(req))),
                    router => router.post("/assign", requirePermission("seat:assign", ["userId"]), (req, res) => void res.json(sessionOf(req))),
                    router => router.get("/seats/:organisationId", requirePermission("seat:read"), (_req, res) => void res.json({ ok: true })),
                    router => router.get("/notifications", requirePermission("notification:list"), (_req, res) => void res.json({ ok: true }))
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
        expect(res.body).toEqual({ sub: "sub-7f3a", email: "owner@contractor.example", amr: ["pwd", "email-otp"] })
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

    test("the token's email wins over the session lookup's older copy (an email just changed)", async () => {
        const res = await agent().post("/act").set("Authorization", `Bearer ${await token({ email: "olivia@contractor.example" })}`)
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ sub: "sub-7f3a", email: "olivia@contractor.example", userId: "user-1" })
    })

    describe("a route with a permission (ADR-058, ADR-060)", () => {
        // An owner and a platform admin sign in with the app or a passkey unless a test says otherwise
        const as = async (sub: string, amr: string[] = ["pwd", "totp"]) =>
            `Bearer ${await new SignJWT({ email: `${sub}@example.com`, email_verified: true, amr })
                .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
                .setSubject(sub)
                .setIssuer(issuer)
                .setAudience(issuer)
                .setIssuedAt()
                .setExpirationTime("15m")
                .sign(key)}`

        test("refuses a request without a token (401)", async () => {
            expect((await agent().post("/assign")).status).toBe(401)
        })

        test("runs for a member whose role holds it, in the organisation the body names", async () => {
            const res = await agent().post("/assign").set("Authorization", await as("sub-7f3a")).send({ organisationId: "org-1" })
            expect(res.status).toBe(200)
            expect(res.body).toMatchObject({ userId: "user-1" })
        })

        test("runs in the organisation the path names", async () => {
            expect((await agent().get("/seats/org-1").set("Authorization", await as("sub-7f3a"))).status).toBe(200)
        })

        test("answers 404 in an organisation the caller has no role in: it doesn't say whether it exists", async () => {
            const res = await agent().get("/seats/org-2").set("Authorization", await as("sub-7f3a"))
            expect(res.status).toBe(404)
        })

        test("answers 403 to a member whose roles don't hold it", async () => {
            const res = await agent().get("/seats/org-3").set("Authorization", await as("sub-7f3a"))
            expect(res.status).toBe(403)
            expect(res.body.detail).toMatch(/seat:read in this organisation/)
        })

        test("answers 403 when the request names no organisation and no platform role holds it", async () => {
            expect((await agent().get("/notifications").set("Authorization", await as("sub-7f3a"))).status).toBe(403)
        })

        test("runs for a platform role in any organisation, and where none is named", async () => {
            expect((await agent().get("/seats/org-2").set("Authorization", await as("sub-ops"))).status).toBe(200)
            expect((await agent().get("/notifications").set("Authorization", await as("sub-ops"))).status).toBe(200)
        })

        describe("what the person may use, for the web app (GET /my-permissions, ADR-065)", () => {
            const mine = async (sub: string, query = "", amr?: string[]) =>
                agent().get(`/my-permissions${query}`).set("Authorization", await as(sub, amr))

            test("lists platform roles' permissions everywhere, and none of an organisation's without one named", async () => {
                expect((await mine("sub-ops")).body).toEqual({ permissions: ["notification:list", "seat:read"] })
                expect((await mine("sub-7f3a")).body).toEqual({ permissions: [] })
            })

            test("adds the roles held in the organisation the tenant key names, and nothing for one with no role", async () => {
                expect((await mine("sub-7f3a", "?organisationId=org-4")).body).toEqual({ permissions: ["seat:assign", "seat:read"] })
                expect((await mine("sub-7f3a", "?organisationId=org-3")).body).toEqual({ permissions: [] })
                expect((await mine("sub-7f3a", "?organisationId=org-2")).body).toEqual({ permissions: [] })
            })

            test("counts a role only in its own scope, and organisation roles only where one is named", () => {
                expect(held(roleMap, { platform: ["owner"], organisation: [] })).toEqual([])
                expect(held(roleMap, { platform: [], organisation: ["owner"] })).toEqual([])
                expect(held(roleMap, { platform: [], organisation: ["owner"] }, "org-1")).toEqual(["seat:assign", "seat:read"])
                expect(held(roleMap, { platform: ["platformAdmin"], organisation: ["platformAdmin"] }, "org-1")).toEqual(["notification:list", "seat:read"])
            })

            test("lists a permission held only at a stronger sign-in: using it asks to step up", async () => {
                const res = await mine("sub-7f3a", "?organisationId=org-1", ["pwd", "email-otp"])
                expect(res.status).toBe(200)
                expect(res.body).toEqual({ permissions: ["seat:assign", "seat:read"] })
            })

            test("needs someone signed in, and lists nothing where permissions aren't configured", async () => {
                expect((await agent().get("/my-permissions")).status).toBe(401)
                const bare = await agent(settings, {}).get("/my-permissions").set("Authorization", await as("sub-ops"))
                expect(bare.body).toEqual({ permissions: [] })
            })
        })

        describe("how strongly the caller signed in (ADR-056)", () => {
            const stepUp = (res: supertest.Response, level: string) => {
                expect(res.status).toBe(401)
                expect(res.headers["www-authenticate"]).toContain('error="insufficient_user_authentication"')
                expect(res.headers["www-authenticate"]).toContain(`acr_values="${level}"`)
                expect(res.body.signIn).toBe(level)
            }

            test("an owner who proved only the inbox is asked for the app or a passkey, and doesn't run", async () => {
                stepUp(await agent().get("/seats/org-1").set("Authorization", await as("sub-7f3a", ["pwd", "email-otp"])), "not-by-email")
                stepUp(await agent().get("/seats/org-1").set("Authorization", await as("sub-7f3a", ["pwd", "trusted-device"])), "not-by-email")
            })

            test("an owner with the app, a backup code or a passkey runs", async () => {
                for (const amr of [["pwd", "totp"], ["pwd", "backup-code"], ["passkey"]])
                    expect((await agent().get("/seats/org-1").set("Authorization", await as("sub-7f3a", amr))).status, amr.join()).toBe(200)
            })

            test("a role the caller also holds, with a lower level, is enough on its own", async () => {
                expect((await agent().get("/seats/org-4").set("Authorization", await as("sub-7f3a", ["pwd", "email-otp"]))).status).toBe(200)
                stepUp(await agent().post("/assign").set("Authorization", await as("sub-7f3a", ["pwd", "email-otp"])).send({ organisationId: "org-4" }), "not-by-email")
            })

            test("a passkey or the app proved over 12 hours ago (mfa, D15) is still a second factor, but an owner is asked again", async () => {
                const lapsed = await as("sub-7f3a", ["mfa"])
                expect((await agent().get("/seats/org-4").set("Authorization", lapsed)).status).toBe(200)
                stepUp(await agent().get("/seats/org-1").set("Authorization", lapsed), "not-by-email")
            })

            test("a platform admin needs the app or a passkey too", async () => {
                stepUp(await agent().get("/notifications").set("Authorization", await as("sub-ops", ["pwd", "email-otp"])), "not-by-email")
            })

            test("asking for a step-up never says more than a 404 or 403 would", async () => {
                const weak = await as("sub-7f3a", ["pwd", "email-otp"])
                expect((await agent().get("/seats/org-2").set("Authorization", weak)).status).toBe(404)
                expect((await agent().get("/seats/org-3").set("Authorization", weak)).status).toBe(403)
            })
        })

        test("denies everyone when the roles aren't configured", async () => {
            const res = await agent(settings, {}).get("/seats/org-1").set("Authorization", await as("sub-7f3a"))
            expect(res.status).toBe(403)
            expect(res.body.detail).toMatch(/aren't configured/)
        })
    })

    test.each([
        ["a password alone", ["pwd"]],
        ["no factors at all", []],
        ["no amr claim", undefined]
    ])("a session with %s is asked for a second factor on every signed-in route (ADR-056 D2)", async (_, amr) => {
        const res = await agent().get("/mine").set("Authorization", `Bearer ${await token({ amr })}`)
        expect(res.status).toBe(401)
        expect(res.headers["www-authenticate"]).toContain('error="insufficient_user_authentication"')
        expect(res.body.signIn).toBe("second-factor")
        expect((await agent().get("/who").set("Authorization", `Bearer ${await token({ amr })}`)).status).toBe(200)
    })

    test("signed in but not registered: 403, register first", async () => {
        const stranger = await new SignJWT({ email: "new@example.com", email_verified: true, amr: ["pwd", "email-otp"] })
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
