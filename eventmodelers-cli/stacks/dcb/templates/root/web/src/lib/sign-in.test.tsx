import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { signInService } from "./auth-client"
import { SessionProvider } from "./session"
import { ForgotPasswordPage, LinkExpired, nextPath, ResetPasswordPage, SignInForm, SignUpForm } from "./sign-in"
import { Layout } from "@/Layout"

// The kit's sign-in screens (ADR-057), with the sign-in service answered here
const inRouter = (ui: React.ReactNode, path = "/") => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>)
const ok = (data: unknown = {}) => ({ data, error: null }) as never
const refused = (status: number, message?: string, code?: string) => ({ data: null, error: { status, message, code } }) as never

async function passwordFirst(methods: string[]) {
    vi.spyOn(signInService, "signInWithEmail").mockResolvedValue(ok({ twoFactorRedirect: true, twoFactorMethods: methods }))
    inRouter(<SignInForm next="/" />)
    await userEvent.type(screen.getByLabelText("Email"), "owner@contractor.example")
    await userEvent.type(screen.getByLabelText("Password"), "correct horse battery staple")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    return screen.findByRole("form", { name: "Enter your code" })
}

describe("the sign-in screens", () => {
    afterEach(() => vi.restoreAllMocks())

    it("signs up, then asks the person to check their email; the link returns them to the page they came from", async () => {
        const signUp = vi.spyOn(signInService, "signUpWithEmail").mockResolvedValue({ data: { token: null }, error: null } as never)
        inRouter(<SignUpForm next="/get-started" />)
        await userEvent.type(screen.getByLabelText("Name"), "Olivia Owner")
        await userEvent.type(screen.getByLabelText("Email"), "owner@contractor.example")
        await userEvent.type(screen.getByLabelText("Password"), "correct horse battery staple")
        await userEvent.click(screen.getByRole("button", { name: "Sign up" }))
        expect(signUp).toHaveBeenCalledWith({
            name: "Olivia Owner",
            email: "owner@contractor.example",
            password: "correct horse battery staple",
            callbackURL: "/get-started"
        })
        expect(await screen.findByRole("status")).toHaveTextContent("We've sent a link to owner@contractor.example")
        await userEvent.click(screen.getByRole("button", { name: "Sign up again" }))
        expect(screen.getByRole("form", { name: "Sign up" })).toBeInTheDocument()
    })

    it("shows why sign-up failed", async () => {
        vi.spyOn(signInService, "signUpWithEmail").mockResolvedValue({ data: null, error: { status: 400, message: "Password too short" } } as never)
        inRouter(<SignUpForm next="/" />)
        await userEvent.type(screen.getByLabelText("Name"), "O")
        await userEvent.type(screen.getByLabelText("Email"), "o@example.com")
        await userEvent.type(screen.getByLabelText("Password"), "12345678")
        await userEvent.click(screen.getByRole("button", { name: "Sign up" }))
        expect(await screen.findByRole("alert")).toHaveTextContent("Password too short")
    })

    it("links sign-in and sign-up both ways, keeping the page to return to", () => {
        inRouter(<SignInForm next="/get-started" />)
        expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up?next=%2Fget-started")
        inRouter(<SignUpForm next="/get-started" />)
        expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in?next=%2Fget-started")
    })

    it("only ever returns to a page on this site", () => {
        expect(nextPath("/organisations/o1")).toBe("/organisations/o1")
        expect(nextPath("https://evil.example")).toBe("/")
        expect(nextPath("//evil.example")).toBe("/")
        expect(nextPath(null)).toBe("/")
    })

    it("the header shows the signed-in email and Sign out", async () => {
        vi.spyOn(signInService, "useSession").mockReturnValue({ data: { user: { id: "u-1", email: "owner@contractor.example" } }, isPending: false } as never)
        const signOut = vi.spyOn(signInService, "signOut").mockResolvedValue({ data: { success: true }, error: null } as never)
        render(
            <SessionProvider mode="better-auth" remember={false}>
                <MemoryRouter>
                    <Layout nav={[]} />
                </MemoryRouter>
            </SessionProvider>
        )
        expect(screen.getByRole("navigation")).toHaveTextContent("owner@contractor.example")
        expect(screen.getByRole("navigation")).not.toHaveTextContent("u-1")
        await userEvent.click(screen.getByRole("button", { name: "Sign out" }))
        expect(signOut).toHaveBeenCalled()
    })

    it("signs up with a password of at least 12 characters, and sends the link again from check-your-email", async () => {
        vi.spyOn(signInService, "signUpWithEmail").mockResolvedValue(ok({ token: null }))
        const again = vi.spyOn(signInService, "sendVerificationEmail").mockResolvedValue(ok())
        inRouter(<SignUpForm next="/get-started" />)
        expect(screen.getByLabelText("Password")).toHaveAttribute("minLength", "12")
        await userEvent.type(screen.getByLabelText("Name"), "O")
        await userEvent.type(screen.getByLabelText("Email"), "o@example.com")
        await userEvent.type(screen.getByLabelText("Password"), "correct horse battery staple")
        await userEvent.click(screen.getByRole("button", { name: "Sign up" }))
        await userEvent.click(await screen.findByRole("button", { name: "Send it again" }))
        expect(again).toHaveBeenCalledWith("o@example.com", "/get-started")
        expect(await screen.findByText("We've sent it again.")).toBeInTheDocument()
    })
})

describe("the second factor at sign-in (ADR-056 D2, D4a)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("after the password, emails a code once and checks it, trusting the device when asked", async () => {
        const send = vi.spyOn(signInService, "sendCode").mockResolvedValue(ok())
        const verify = vi.spyOn(signInService, "verifyCode").mockResolvedValue(ok())
        await passwordFirst(["otp"])
        expect(await screen.findByRole("status")).toHaveTextContent("We've emailed you a 6-digit code")
        expect(send).toHaveBeenCalledTimes(1)
        await userEvent.type(screen.getByLabelText("Code"), "123456")
        await userEvent.click(screen.getByLabelText("Trust this device for 30 days"))
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(verify).toHaveBeenCalledWith("123456", true)
        await userEvent.click(screen.getByRole("button", { name: "Send a new code" }))
        expect(send).toHaveBeenCalledTimes(2)
    })

    it("someone with the app is asked for its code, never emailed one, with a backup code or a passkey as the ways round", async () => {
        const send = vi.spyOn(signInService, "sendCode").mockResolvedValue(ok())
        const app = vi.spyOn(signInService, "verifyAppCode").mockResolvedValue(refused(401, "Invalid code"))
        const backup = vi.spyOn(signInService, "verifyBackupCode").mockResolvedValue(ok())
        await passwordFirst(["totp"])
        expect(screen.getByText("Enter the 6-digit code from your authenticator app.")).toBeInTheDocument()
        expect(send).not.toHaveBeenCalled()
        await userEvent.type(screen.getByLabelText("Code"), "000000")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(app).toHaveBeenCalledWith("000000", false)
        expect(await screen.findByRole("alert")).toHaveTextContent("Invalid code")

        await userEvent.click(screen.getByRole("button", { name: "Use a backup code" }))
        await userEvent.type(screen.getByLabelText("Backup code"), "abcde-fghij")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(backup).toHaveBeenCalledWith("abcde-fghij", false)

        // No passkey offered here: whether they have one isn't known yet ("Sign in with a passkey" is on the first screen)
        expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull()
    })

    it("someone with only a passkey is offered nothing by email: the passkey finishes signing in", async () => {
        const send = vi.spyOn(signInService, "sendCode").mockResolvedValue(ok())
        const passkey = vi.spyOn(signInService, "signInWithPasskey").mockResolvedValue(ok())
        await passwordFirst([])
        expect(screen.getByRole("heading", { name: "Use your passkey" })).toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }))
        expect(passkey).toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it("too many attempts says so (D11)", async () => {
        vi.spyOn(signInService, "signInWithEmail").mockResolvedValue(refused(429, "Too many requests"))
        inRouter(<SignInForm next="/" />)
        await userEvent.type(screen.getByLabelText("Email"), "o@example.com")
        await userEvent.type(screen.getByLabelText("Password"), "correct horse battery staple")
        await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
        expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts: try again in a few minutes.")
    })

    it("links to the forgotten-password page", () => {
        inRouter(<SignInForm next="/" />)
        expect(screen.getByRole("link", { name: "Forgotten your password?" })).toHaveAttribute("href", "/forgot-password")
    })
})

describe("a forgotten password (ADR-056 D4)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("emails a link, with the same answer whether or not there's an account", async () => {
        const ask = vi.spyOn(signInService, "requestPasswordReset").mockResolvedValue(ok({ status: true }))
        inRouter(<ForgotPasswordPage />)
        await userEvent.type(screen.getByLabelText("Email"), "nobody@example.com")
        await userEvent.click(screen.getByRole("button", { name: "Send the link" }))
        expect(ask).toHaveBeenCalledWith("nobody@example.com")
        expect(await screen.findByRole("status")).toHaveTextContent("If nobody@example.com has an account, we've sent it a link")
    })

    it("the link's page sets a new password, then says every session was signed out", async () => {
        const reset = vi.spyOn(signInService, "resetPassword").mockResolvedValue(ok({ status: true }))
        inRouter(<ResetPasswordPage />, "/reset-password?token=t-1")
        await userEvent.type(screen.getByLabelText("New password"), "a brand new long password")
        await userEvent.click(screen.getByRole("button", { name: "Change my password" }))
        expect(reset).toHaveBeenCalledWith("t-1", "a brand new long password")
        expect(await screen.findByRole("status")).toHaveTextContent("Every session was signed out")
    })

    it("an expired or used link says so, and offers a new one", () => {
        inRouter(<ResetPasswordPage />, "/reset-password?error=INVALID_TOKEN")
        expect(screen.getByRole("alert")).toHaveTextContent("This link has expired")
        expect(screen.getByRole("link", { name: "Send me a new link" })).toHaveAttribute("href", "/forgot-password")
    })
})

describe("a verification link that expired (ADR-056 D12)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("shows above the page it landed on, and sends a new link back to that page", async () => {
        const again = vi.spyOn(signInService, "sendVerificationEmail").mockResolvedValue(ok())
        inRouter(<LinkExpired />, "/get-started?error=TOKEN_EXPIRED")
        await userEvent.type(screen.getByLabelText("Email"), "o@example.com")
        await userEvent.click(screen.getByRole("button", { name: "Send me a new link" }))
        expect(again).toHaveBeenCalledWith("o@example.com", "/get-started")
        expect(await screen.findByRole("status")).toHaveTextContent("We've sent a new link to o@example.com")
    })

    it("an email change's expired link says to start the change again, not to verify", () => {
        inRouter(<LinkExpired />, "/email-changed?error=TOKEN_EXPIRED")
        expect(screen.getByRole("alert")).toHaveTextContent("Your email hasn't changed")
        expect(screen.getByRole("link", { name: "Change it again from your account" })).toHaveAttribute("href", "/account")
        expect(screen.queryByLabelText("Email")).toBeNull()
    })

    it("shows nothing on a page without a link problem", () => {
        inRouter(<LinkExpired />, "/get-started")
        expect(screen.queryByRole("form")).toBeNull()
    })
})

