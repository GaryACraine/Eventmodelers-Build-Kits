import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router"
import { signInService } from "./auth-client"
import { useReturnTo, type Navigation } from "./navigation"
import { RequireSession, SessionProvider } from "./session"
import { SignUpPage } from "./sign-in"

// Signed out on a page, then back to it, registered (ADR-068): the whole chain, joined. Each step has its own test;
// this one fails when they stop fitting together (an invitation's link once lost its page at the header's Sign up).

const navigation = { tenantKey: "organisationId", entities: {}, menu: [], account: [], pages: {}, register: "/get-started" } as Navigation

function Registration() {
    const returnTo = useReturnTo()
    const navigate = useNavigate()
    return <button onClick={() => navigate(returnTo ?? "/organisations/new")}>Register user</button>
}

function Where() {
    return <p data-testid="at">{useLocation().pathname}</p>
}

function app(at: string) {
    const router = createMemoryRouter(
        [
            { path: "/invitations/:invitationId", element: <><RequireSession keys={["userId"]}><p>The invitation</p></RequireSession><Where /></> },
            { path: "/sign-up", element: <SignUpPage navigation={navigation} /> },
            { path: "/get-started", element: <><Registration /><Where /></> },
            { path: "/organisations/new", element: <Where /> }
        ],
        { initialEntries: [at] }
    )
    render(<SessionProvider mode="better-auth" remember={false}><RouterProvider router={router} /></SessionProvider>)
    return router
}

describe("signed out on a page: back to it, registered (ADR-068)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("signs up from the page, registers on the registration page, and comes back to the page", async () => {
        const session = vi.spyOn(signInService, "useSession").mockReturnValue({ data: null, isPending: false } as never)
        const signUp = vi.spyOn(signInService, "signUpWithEmail").mockResolvedValue({ data: {}, error: null } as never)

        // 1. The page asks them to sign in; its Sign up keeps the page
        const router = app("/invitations/i1")
        await userEvent.click(await screen.findByRole("link", { name: "Sign up" }))
        expect(router.state.location.search).toBe("?next=%2Finvitations%2Fi1")

        // 2. Signing up: the verification link will land on the registration page, carrying the page
        await userEvent.type(screen.getByLabelText("Name"), "Ada")
        await userEvent.type(screen.getByLabelText("Email"), "ada@example.com")
        await userEvent.type(screen.getByLabelText("Password"), "a-long-enough-password")
        await userEvent.click(screen.getByRole("button", { name: "Sign up" }))
        const landing = signUp.mock.calls[0][0].callbackURL!
        expect(landing).toBe("/get-started?next=%2Finvitations%2Fi1")

        // 3. The link signs them in and lands there; registering goes on to the page, not the registration's own next
        session.mockReturnValue({ data: { user: { id: "sub-1", email: "ada@example.com" } }, isPending: false } as never)
        await router.navigate(landing)
        await userEvent.click(await screen.findByRole("button", { name: "Register user" }))
        expect(await screen.findByTestId("at")).toHaveTextContent("/invitations/i1")
    })

    it("without somewhere to go back to, registering goes on as the model says", async () => {
        vi.spyOn(signInService, "useSession").mockReturnValue({ data: { user: { id: "sub-1", email: "ada@example.com" } }, isPending: false } as never)
        app("/get-started")
        await userEvent.click(await screen.findByRole("button", { name: "Register user" }))
        expect(await screen.findByTestId("at")).toHaveTextContent("/organisations/new")
    })
})
