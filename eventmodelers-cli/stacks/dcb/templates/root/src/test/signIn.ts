import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import type { WebApiSetup } from "@dcb-es/event-store-express"
import { configureSignIn, type SessionLookup } from "../shared/signIn.js"
import type { CallerRoles, RoleLookup, RoleMap } from "../shared/permissions.js"

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
 */
export async function testSignIn(lookup?: SessionLookup, access: { roles?: CallerRoles | RoleLookup; roleMap?: RoleMap } = {}) {
    const roles: RoleLookup | undefined =
        typeof access.roles === "function" ? access.roles : access.roles ? async () => access.roles as CallerRoles : undefined
    const issuer = "http://sign-in.test"
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "test" }] })
    return {
        configure: (): WebApiSetup => configureSignIn({ settings: { issuer, audience: issuer, jwks }, lookup, roles, roleMap: access.roleMap }),
        /** The Authorization header for someone signed in, with a verified email */
        bearer: async ({ sub, email = `${sub}@example.com` }: { sub: string; email?: string }) =>
            `Bearer ${await new SignJWT({ email, email_verified: true })
                .setProtectedHeader({ alg: "EdDSA", kid: "test" })
                .setSubject(sub)
                .setIssuer(issuer)
                .setAudience(issuer)
                .setIssuedAt()
                .setExpirationTime("15m")
                .sign(privateKey)}`
    }
}
