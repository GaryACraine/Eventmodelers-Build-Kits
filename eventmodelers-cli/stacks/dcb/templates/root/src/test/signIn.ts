import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import type { WebApiSetup } from "@dcb-es/event-store-express"
import { configureSignIn, type SessionLookup } from "../shared/signIn.js"

/**
 * Sign-in for a route's tests (ADR-055 part 2): a key of the test's own stands in for the sign-in service's, so a
 * route that uses the signed-in person's values can be called as someone.
 *
 *   const signIn = await testSignIn(async sub => (sub === "sub-7f3a" ? { userId: "user-1" } : undefined))
 *   const app = getApplication({ apis: [signIn.configure(), configureActivateOrganisationRoute(deps)] })
 *   await supertest(app).post("/activate-organisation").set("Authorization", await signIn.bearer({ sub: "sub-7f3a" })).send({ name: "Acme" })
 *
 * `lookup` is the session lookup (the read model marked --session-lookup), for keys the token doesn't hold (userId).
 */
export async function testSignIn(lookup?: SessionLookup) {
    const issuer = "http://sign-in.test"
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "test" }] })
    return {
        configure: (): WebApiSetup => configureSignIn({ settings: { issuer, audience: issuer, jwks }, lookup }),
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
