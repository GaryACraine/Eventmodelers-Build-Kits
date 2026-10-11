import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { server } from "@/mocks/server"
import { signInService } from "./auth-client"
import { AccountPage } from "./account"
import { SessionProvider } from "./session"
import { StepUpPrompt, StepUpProvider } from "./step-up"
import { MemoryRouter } from "react-router"

// Signing in more strongly (ADR-056 D1, D3): the prompt, the API client sending the request again, and the account
// page asking for it before changing a factor. Real sign-in is on here (the stub has nothing to step up to).
vi.mock("./auth-client", async (original) => ({
    ...(await original<typeof import("./auth-client")>()),
    signInMode: "better-auth",
    bearerToken: vi.fn(async () => "a-token")
}))

const ok = (data: unknown = {}) => ({ data, error: null }) as never
const refused = (status: number, message?: string, code?: string) => ({ data: null, error: { status, message, code } }) as never
const signedIn = () =>
    vi.spyOn(signInService, "useSession").mockReturnValue({ data: { user: { id: "u-1", email: "owner@contractor.example" } }, isPending: false } as never)

const inApp = (ui: React.ReactNode) =>
    render(
        <SessionProvider mode="better-auth" remember={false}>
            <StepUpProvider>
                <MemoryRouter>{ui}</MemoryRouter>
            </StepUpProvider>
        </SessionProvider>
    )

describe("the step-up prompt", () => {
    beforeEach(() => signedIn())
    afterEach(() => vi.restoreAllMocks())

    it("asks someone with the app for its code", async () => {
        vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: true, passkeys: 0 }))
        const verify = vi.spyOn(signInService, "verifyAppCode").mockResolvedValue(ok())
        const done = vi.fn()
        inApp(<StepUpPrompt level="not-by-email" onDone={done} />)
        await userEvent.type(await screen.findByLabelText("Code from your app"), "123456")
        await userEvent.click(screen.getByRole("button", { name: "Confirm" }))
        expect(verify).toHaveBeenCalledWith("123456")
        expect(done).toHaveBeenCalledWith(true)
    })

    it("offers a passkey to someone who has one", async () => {
        vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: false, passkeys: 1 }))
        vi.spyOn(signInService, "signInWithPasskey").mockResolvedValue(ok())
        const done = vi.fn()
        inApp(<StepUpPrompt level="not-by-email" onDone={done} />)
        await userEvent.click(await screen.findByRole("button", { name: "Use your passkey" }))
        expect(done).toHaveBeenCalledWith(true)
    })

    it("helps someone with neither set up the app: password, QR code, its first code, the backup codes, then its next code", async () => {
        const factors = vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: false, passkeys: 0 }))
        vi.spyOn(signInService, "setUpApp").mockResolvedValue(
            ok({ totpURI: "otpauth://totp/app:owner?secret=JBSWY3DPEHPK3PXP&issuer=app", backupCodes: ["aaaaa-bbbbb", "ccccc-ddddd"] })
        )
        const verify = vi.spyOn(signInService, "verifyAppCode").mockResolvedValue(ok())
        const done = vi.fn()
        inApp(<StepUpPrompt level="not-by-email" onDone={done} />)
        expect(await screen.findByText(/someone who got into your email couldn't use/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Set up the authenticator app" }))
        await userEvent.type(screen.getByLabelText("Your password"), "correct horse battery staple")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(await screen.findByRole("img", { name: "QR code for your authenticator app" })).toBeInTheDocument()
        expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument()
        await userEvent.type(screen.getByLabelText("The code the app shows"), "111111")
        await userEvent.click(screen.getByRole("button", { name: "Finish setting up" }))
        expect(await screen.findByText(/aaaaa-bbbbb/)).toBeInTheDocument()

        // Setting it up proves nothing yet: its next code does
        factors.mockResolvedValue(ok({ app: true, passkeys: 0 }))
        await userEvent.click(screen.getByRole("button", { name: "I've saved them" }))
        expect(done).not.toHaveBeenCalled()
        await userEvent.type(await screen.findByLabelText("Code from your app"), "222222")
        await userEvent.click(screen.getByRole("button", { name: "Confirm" }))
        expect(verify).toHaveBeenLastCalledWith("222222")
        expect(done).toHaveBeenCalledWith(true)
    })

    it("can be put off", async () => {
        vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: true, passkeys: 0 }))
        const done = vi.fn()
        inApp(<StepUpPrompt level="not-by-email" onDone={done} />)
        await userEvent.click(screen.getByRole("button", { name: "Not now" }))
        expect(done).toHaveBeenCalledWith(false)
    })
})

describe("the API client and a step-up", () => {
    beforeEach(() => signedIn())
    afterEach(() => vi.restoreAllMocks())

    const challenge = {
        "WWW-Authenticate": 'Bearer error="insufficient_user_authentication", error_description="Confirm it is you", acr_values="not-by-email"'
    }

    it("shows the prompt, then sends the same request again (same body, same Idempotency-Key)", async () => {
        const { api, apiUrl, command } = await import("./api")
        const seen: { key: string | null; body: unknown }[] = []
        server.use(
            http.post(apiUrl("/step-up-probe"), async ({ request }) => {
                seen.push({ key: request.headers.get("Idempotency-Key"), body: await request.json() })
                return seen.length === 1 ? HttpResponse.json({ signIn: "not-by-email" }, { status: 401, headers: challenge }) : new HttpResponse(null, { status: 204 })
            })
        )
        vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: true, passkeys: 0 }))
        vi.spyOn(signInService, "verifyAppCode").mockResolvedValue(ok())
        inApp(<p>page</p>)

        const sent = command(api.POST("/step-up-probe" as never, { body: { organisationId: "o-1" } } as never))
        await userEvent.type(await screen.findByLabelText("Code from your app"), "123456")
        await userEvent.click(screen.getByRole("button", { name: "Confirm" }))
        await sent
        expect(seen).toHaveLength(2)
        expect(seen[1]).toEqual(seen[0])
        expect(seen[0]!.key).toBeTruthy()
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    })

    it("put off, the 401 stands, and says what it asked for", async () => {
        const { api, apiUrl, command, ApiError } = await import("./api")
        server.use(http.post(apiUrl("/step-up-probe"), () => HttpResponse.json({}, { status: 401, headers: challenge })))
        vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: true, passkeys: 0 }))
        inApp(<p>page</p>)
        const sent = command(api.POST("/step-up-probe" as never, { body: {} } as never)).catch((e: unknown) => e)
        await userEvent.click(await screen.findByRole("button", { name: "Not now" }))
        const error = await sent
        expect(error).toBeInstanceOf(ApiError)
        expect((error as InstanceType<typeof ApiError>).stepUp).toBe("not-by-email")
    })
})

describe("the account page", () => {
    beforeEach(() => {
        signedIn()
        vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: false, passkeys: 0 }))
        vi.spyOn(signInService, "listPasskeys").mockResolvedValue(ok([]))
        vi.spyOn(signInService, "listSessions").mockResolvedValue(ok([]))
    })
    afterEach(() => vi.restoreAllMocks())

    it("changes the password, signing out the other sessions (D5)", async () => {
        const change = vi.spyOn(signInService, "changePassword").mockResolvedValue(ok())
        inApp(<AccountPage />)
        await userEvent.type(screen.getByLabelText("Current password"), "correct horse battery staple")
        await userEvent.type(screen.getByLabelText("New password"), "a brand new long password")
        await userEvent.click(screen.getByRole("button", { name: "Change my password" }))
        expect(change).toHaveBeenCalledWith("correct horse battery staple", "a brand new long password")
        expect(await screen.findByText(/every other session was signed out/)).toBeInTheDocument()
    })

    it("changes the email: confirmed at the current address, then verified at the new one (D6)", async () => {
        const change = vi.spyOn(signInService, "changeEmail").mockResolvedValue(ok())
        inApp(<AccountPage />)
        await userEvent.type(screen.getByLabelText("New email"), "new@contractor.example")
        await userEvent.click(screen.getByRole("button", { name: "Change my email" }))
        expect(change).toHaveBeenCalledWith("new@contractor.example", "/account?email=changing")
        expect(await screen.findByText(/We've emailed owner@contractor.example to confirm/)).toBeInTheDocument()
    })

    it("adding a passkey when the service wants the strongest factor first: asks for it, then adds it", async () => {
        const add = vi
            .spyOn(signInService, "addPasskey")
            .mockResolvedValueOnce(refused(403, "Confirm it's you with your authenticator app or passkey first", "STRONGER_FACTOR_REQUIRED"))
            .mockResolvedValueOnce(ok())
        vi.spyOn(signInService, "factors").mockResolvedValue(ok({ app: true, passkeys: 0 }))
        vi.spyOn(signInService, "verifyAppCode").mockResolvedValue(ok())
        inApp(<AccountPage />)
        await userEvent.click(screen.getByRole("button", { name: "Add a passkey" }))
        await userEvent.type(await screen.findByLabelText("Code from your app"), "123456")
        await userEvent.click(screen.getByRole("button", { name: "Confirm" }))
        await waitFor(() => expect(add).toHaveBeenCalledTimes(2))
        expect(screen.queryByRole("alert")).toBeNull()
    })

    it("signs out everywhere else (D9)", async () => {
        const out = vi.spyOn(signInService, "signOutEverywhereElse").mockResolvedValue(ok())
        inApp(<AccountPage />)
        await userEvent.click(screen.getByRole("button", { name: "Sign out everywhere else" }))
        expect(out).toHaveBeenCalled()
        expect(await screen.findByText("Signed out everywhere else.")).toBeInTheDocument()
    })
})
