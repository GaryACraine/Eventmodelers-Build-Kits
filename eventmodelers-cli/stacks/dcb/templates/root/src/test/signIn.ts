import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import type { WebApiSetup } from "@dcb-es/event-store-express"
import { configureSignIn, type SessionLookup } from "../shared/signIn.js"
import type { RoleLookup, RoleMap } from "../shared/permissions.js"

/**
 * Sign-in for a route's tests (ADR-055 part 2): a key of the test's own stands in for the sign-in service's, so a
 * route that uses the signed-in person's values can be called as someone.
 *
 *   const signIn = await testSignIn(async sub => (sub === "sub-7f3a" ? { userId: "user-1" } : undefined))
 *   const app = getApplication({ apis: [signIn.configure(), configureActivateOrganisationRoute(deps)] })
 *   await supertest(app).post("/activate-organisation").set("Authorization", await signIn.bearer({ sub: "sub-7f3a" })).send({ name: "Acme" })
 *
 * `lookup` is the session lookup (the read model marked --session-lookup), for keys the token doesn't hold (userId).
 *
 * A permission route's tests also say what the caller holds (ADR-060): `access.roles`, the roles (or a lookup by
 * caller), checked against the project's role map (`api/roles.json`, or `access.roleMap`):
 *
 *   const signIn = await testSignIn(lookup, { roles: { platform: [], organisations: { "org-1": ["owner"] } } })
 *
 * The token says how the session signed in (`amr`, ADR-056): a password and the authenticator app by default, which is
 * enough for every role, so a test that isn't about sign-in strength never depends on the role map's levels (changing a
 * role's level rebuilds nothing). The step-up test says how weakly the caller signed in:
 *
 *   await signIn.bearer({ sub: "sub-owner", amr: ["pwd", "email-otp"] })   // an owner (not-by-email): 401, step up
 */
export async function testSignIn(
    lookup?: SessionLookup,
    access: { roles?: { platform?: string[]; organisations?: Record<string, string[]> } | RoleLookup; roleMap?: RoleMap } = {}
) {
    const given = access.roles
    const roles: RoleLookup | undefined =
        typeof given === "function"
            ? given
            : given
              ? async (_caller, organisation) => ({
                    platform: given.platform ?? [],
                    organisation: (organisation && given.organisations?.[organisation]) || []
                })
              : undefined
    const issuer = "http://sign-in.test"
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "test" }] })
    return {
        configure: (): WebApiSetup => configureSignIn({ settings: { issuer, audience: issuer, jwks }, lookup, roles, roleMap: access.roleMap }),
        /** The Authorization header for someone signed in, with a verified email */
        bearer: async ({ sub, email = `${sub}@example.com`, amr = ["pwd", "totp"] }: { sub: string; email?: string; amr?: string[] }) =>
            `Bearer ${await new SignJWT({ email, email_verified: true, amr })
                .setProtectedHeader({ alg: "EdDSA", kid: "test" })
                .setSubject(sub)
                .setIssuer(issuer)
                .setAudience(issuer)
                .setIssuedAt()
                .setExpirationTime("15m")
                .sign(privateKey)}`
    }
}
