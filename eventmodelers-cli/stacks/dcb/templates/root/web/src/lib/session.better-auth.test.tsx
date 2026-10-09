import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { RequireSession, SessionProvider, useSession, useSessionState } from "./session"
import { signInService } from "./auth-client"

// Real sign-in's session (ADR-055), with Better Auth's client answered here instead of by the sign-in service
type Answer = { data: { user: { id: string; email: string } } | null; isPending: boolean }
let answer: Answer
vi.spyOn(signInService, "useSession").mockImplementation(() => answer as never)

function Greeting() {
    const { sub, email, userId } = useSession()
    return <p>{[sub, email, userId].filter(Boolean).join(" ")}</p>
}

function SignOut() {
    return <button onClick={useSessionState().signOut}>Sign out</button>
}

const page = (keys: string[]) => (
    <MemoryRouter initialEntries={["/get-started"]}>
        <SessionProvider mode="better-auth" remember={false}>
            <SignOut />
            <RequireSession keys={keys}>
                <Greeting />
            </RequireSession>
        </SessionProvider>
    </MemoryRouter>
)

describe("the session with real sign-in (better-auth)", () => {

    it("waits while it finds out who is signed in", () => {
        answer = { data: null, isPending: true }
        render(page(["sub"]))
        expect(screen.getByRole("status")).toHaveTextContent("Checking who is signed in")
    })

    it("asks no one signed in to sign in, and says when the email isn't verified yet", async () => {
        answer = { data: null, isPending: false }
        const signIn = vi.spyOn(signInService, "signInWithEmail").mockResolvedValue({ data: null, error: { status: 403, message: "Email not verified" } } as never)
        render(page(["sub"]))
        const form = screen.getByRole("form", { name: "Sign in" })
        expect(form).toHaveTextContent("Sign in")
        await userEvent.type(screen.getByLabelText("Email"), "owner@contractor.example")
        await userEvent.type(screen.getByLabelText("Password"), "correct horse battery staple")
        await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
        expect(signIn).toHaveBeenCalledWith("owner@contractor.example", "correct horse battery staple")
        expect(await screen.findByRole("alert")).toHaveTextContent("Verify your email address first")
        expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up?next=%2Fget-started")
    })

    it("gives the page sub and email from the signed-in user", () => {
        answer = { data: { user: { id: "u-1", email: "owner@contractor.example" } }, isPending: false }
        render(page(["sub", "email"]))
        expect(screen.getByText("u-1 owner@contractor.example")).toBeInTheDocument()
    })

    it("asks for a key sign-in doesn't hold yet (userId, ADR-055 part 2)", async () => {
        answer = { data: { user: { id: "u-1", email: "owner@contractor.example" } }, isPending: false }
        render(page(["sub", "userId"]))
        await userEvent.type(screen.getByLabelText("User ID"), "user-9")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(screen.getByText("u-1 owner@contractor.example user-9")).toBeInTheDocument()
    })

    it("signs out of the sign-in service", async () => {
        answer = { data: { user: { id: "u-1", email: "owner@contractor.example" } }, isPending: false }
        const signOut = vi.spyOn(signInService, "signOut").mockResolvedValue({ data: { success: true }, error: null } as never)
        render(page(["sub"]))
        await userEvent.click(screen.getByRole("button", { name: "Sign out" }))
        expect(signOut).toHaveBeenCalled()
    })
})
