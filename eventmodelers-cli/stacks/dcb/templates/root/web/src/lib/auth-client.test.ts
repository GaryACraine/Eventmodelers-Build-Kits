import { signInService, bearerToken, forgetBearerToken } from "./auth-client"

/** A JWT whose payload expires at `exp` (seconds); the signature isn't read here */
const jwt = (exp: number) => `h.${btoa(JSON.stringify({ sub: "u1", exp })).replace(/=+$/, "")}.s`

describe("the bearer token (ADR-055)", () => {
    afterEach(() => {
        forgetBearerToken()
        vi.restoreAllMocks()
    })

    it("asks the sign-in service once, and keeps the token until a minute before it expires", async () => {
        const now = 1_800_000_000_000
        const first = jwt(now / 1000 + 15 * 60)
        const token = vi.spyOn(signInService, "token").mockResolvedValue({ data: { token: first }, error: null } as never)

        expect(await bearerToken(now)).toBe(first)
        expect(await bearerToken(now + 13 * 60_000)).toBe(first)
        expect(token).toHaveBeenCalledTimes(1)

        const second = jwt(now / 1000 + 30 * 60)
        token.mockResolvedValue({ data: { token: second }, error: null } as never)
        expect(await bearerToken(now + 14.5 * 60_000)).toBe(second)
        expect(token).toHaveBeenCalledTimes(2)
    })

    it("is undefined when no one is signed in, and forgetting it asks again", async () => {
        const token = vi.spyOn(signInService, "token").mockResolvedValue({ data: null, error: { status: 401 } } as never)
        expect(await bearerToken()).toBeUndefined()
        token.mockResolvedValue({ data: { token: jwt(Date.now() / 1000 + 900) }, error: null } as never)
        expect(await bearerToken()).toBeDefined()
        forgetBearerToken()
        await bearerToken()
        expect(token).toHaveBeenCalledTimes(3)
    })
})
