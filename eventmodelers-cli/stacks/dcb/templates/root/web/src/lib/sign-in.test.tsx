import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { signInService } from "./auth-client"
import { SessionProvider } from "./session"
import { nextPath, SignInForm, SignUpForm } from "./sign-in"
import { Layout } from "@/Layout"

// The kit's sign-in screens (ADR-057), with the sign-in service answered here
const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

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
})
