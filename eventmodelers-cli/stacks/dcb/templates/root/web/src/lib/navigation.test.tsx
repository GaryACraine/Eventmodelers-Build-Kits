import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { MemoryRouter } from "react-router"
import { Layout } from "@/Layout"
import { server } from "@/mocks/server"
import { apiUrl } from "./api"
import { signInService } from "./auth-client"
import { allows, forgetPermissions, pageAllowed, type Navigation } from "./navigation"
import { SessionProvider } from "./session"

// The menu from the model (ADR-065): permissions, never roles, and what the API says the person holds
const navigation: Navigation = {
    tenantKey: "organisationId",
    entities: { organisationId: { label: "Organisation", plural: "Organisations" } },
    menu: [
        { title: "Organisations", path: "/organisations", entity: "organisationId", create: "/organisations/new" },
        { area: "Support", items: [{ title: "Notifications", path: "/notifications" }, { title: "Settings", path: "/settings" }] }
    ],
    account: [{ title: "Profile", path: "/profile" }],
    pages: {
        "/organisations": { title: "Organisations", context: "licensing", entity: "organisationId", shape: "list", tenant: false, reads: ["self"], actions: [] },
        "/organisations/new": { title: "Activate", context: "licensing", entity: "organisationId", shape: "new", tenant: false, reads: [], actions: [{ command: "activateOrganisation", api: "self" }] },
        "/notifications": { title: "Notifications", context: "licensing", area: "Support", tenant: false, reads: ["notification:list"], actions: [] },
        "/settings": { title: "Settings", context: "licensing", area: "Support", tenant: false, reads: ["settings:read"], actions: [] },
        "/profile": { title: "Profile", context: "identity", area: "account", tenant: false, reads: ["self"], actions: [] }
    }
}

function signedInAs(email: string, permissions: string[]) {
    forgetPermissions()
    vi.spyOn(signInService, "useSession").mockReturnValue({ data: { user: { id: `sub-${email}`, email } }, isPending: false } as never)
    server.use(http.get(apiUrl("/my-permissions"), () => HttpResponse.json({ permissions })))
    render(
        <SessionProvider mode="better-auth" remember={false}>
            <MemoryRouter>
                <Layout nav={[]} navigation={navigation} />
            </MemoryRouter>
        </SessionProvider>
    )
    return screen.getByRole("navigation")
}

describe("what the menu offers (ADR-065)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("allows anonymous to anyone, self to anyone signed in, a permission to whoever holds it", () => {
        expect(allows("anonymous", [], false)).toBe(true)
        expect(allows("self", [], false)).toBe(false)
        expect(allows("self", [], true)).toBe(true)
        expect(allows("notification:list", ["notification:list"], true)).toBe(true)
        expect(allows("notification:list", [], true)).toBe(false)
        expect(pageAllowed(navigation.pages["/settings"], ["notification:list"], true)).toBe(false)
    })

    it("shows an owner their organisations and their account pages, but not the platform's", async () => {
        const nav = signedInAs("owner@contractor.example", [])
        expect(await within(nav).findByRole("link", { name: "Organisations" })).toHaveAttribute("href", "/organisations")
        expect(within(nav).queryByText("Support")).toBeNull()
        expect(within(nav).queryByText("Notifications")).toBeNull()
        await userEvent.click(within(nav).getByText("owner@contractor.example"))
        expect(within(nav).getByRole("link", { name: "Your account" })).toHaveAttribute("href", "/account")
        expect(within(nav).getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/profile")
        expect(within(nav).getByRole("button", { name: "Sign out" })).toBeInTheDocument()
    })

    it("shows an area's pages one by one, by what the API says the person holds", async () => {
        const nav = signedInAs("ops@example.com", ["notification:list"])
        // one page of the area is allowed: a plain link to it
        expect(await within(nav).findByRole("link", { name: "Notifications" })).toHaveAttribute("href", "/notifications")
        expect(within(nav).queryByText("Settings")).toBeNull()
    })

    it("signed out, offers Sign in and Sign up, and nothing that needs someone signed in", async () => {
        vi.spyOn(signInService, "useSession").mockReturnValue({ data: null, isPending: false } as never)
        render(
            <SessionProvider mode="better-auth" remember={false}>
                <MemoryRouter>
                    <Layout nav={[]} navigation={navigation} />
                </MemoryRouter>
            </SessionProvider>
        )
        const nav = screen.getByRole("navigation")
        expect(within(nav).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in")
        expect(within(nav).getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up")
        expect(within(nav).queryByText("Organisations")).toBeNull()
    })
})
