import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { useEffect, type ReactNode } from "react"
import { createMemoryRouter, Link, RouterProvider } from "react-router"
import { server } from "@/mocks/server"
import { apiUrl } from "./api"
import { signInService } from "./auth-client"
import { ModelPage } from "./model-page"
import { forgetPermissions, type Navigation } from "./navigation"
import type { FormPart, SliceParts, ViewPart } from "./parts"
import { SessionProvider } from "./session"

// A page rendered from the model (ADR-069): licensing's organisation page, its list's row action, the person's own
// list, and the registration page. The parts are stand-ins: what matters is what the page gives them.

type Row = { organisationId?: string; invitationId: string; email: string }

const parts: SliceParts = {
    invitemember: {
        InviteMemberForm: ({ organisationId, onDone }: { organisationId: string } & FormPart) => (
            <button onClick={() => onDone?.({ organisationId, email: "e@example.com" })}>Invite to {organisationId}</button>
        )
    },
    organisationinvitations: {
        OrganisationInvitationsView: ({ organisationId, row }: { organisationId: string } & ViewPart<Row>) => (
            <table aria-label={`Invitations of ${organisationId}`}>
                <tbody>
                    {[{ invitationId: "i1", email: "a@example.com" }, { invitationId: "i2", email: "b@example.com" }].map((r) => (
                        <tr key={r.invitationId}>
                            <td>{r.email}</td>
                            {row && <td>{row(r)}</td>}
                        </tr>
                    ))}
                </tbody>
            </table>
        )
    },
    withdrawinvitation: {
        WithdrawInvitationForm: ({ organisationId, invitationId }: { organisationId: string; invitationId: string }) => (
            <button>Withdraw {invitationId} from {organisationId}</button>
        )
    },
    organisationoverview: {
        OrganisationOverviewView: ({ organisationId }: { organisationId: string }) => <p>Overview of {organisationId}</p>
    },
    activateorganisation: {
        ActivateOrganisationForm: ({ onDone }: FormPart) => (
            <>
                <button onClick={() => onDone?.({ name: "Craine", organisationId: "o9" })}>Activate</button>
                <button onClick={() => onDone?.({ name: "Craine" })}>Activate without an answer</button>
            </>
        )
    },
    myorganisations: {
        MyOrganisationsView: ({ linkTo, onlyOne, createPath, rows }: ViewPart<{ organisationId: string }> & { rows?: string[] }) => {
            const list = (rows ?? ["o1", "o2"]).map((organisationId) => ({ organisationId }))
            useEffect(() => {
                if (list.length === 1) onlyOne?.(list[0])
            })
            return (
                <ul>
                    {list.map((r) => (
                        <li key={r.organisationId}>
                            <Link to={linkTo!(r)}>{r.organisationId}</Link>
                        </li>
                    ))}
                    <li>
                        <Link to={createPath!}>New organisation</Link>
                    </li>
                </ul>
            )
        }
    },
    registeruser: {
        RegisterUserForm: ({ onDone }: FormPart) => <button onClick={() => onDone?.({ userId: "u1" })}>Register user</button>
    },
    mycourses: {
        MyCoursesView: ({ studentId }: { studentId: string }) => <p>Courses of {studentId}</p>
    }
}

const dashboard = "/organisations/:organisationId"
const navigation: Navigation = {
    tenantKey: "organisationId",
    entities: { organisationId: { label: "Organisation", plural: "Organisations" } },
    menu: [],
    account: [],
    register: "/get-started",
    pages: {
        [dashboard]: {
            title: "Dashboard", heading: "Dashboard", context: "licensing", entity: "organisationId", shape: "one", tenant: true,
            reads: ["invitation:list", "organisation:read"],
            actions: [{ command: "inviteMember", api: "invitation:create" }, { command: "withdrawInvitation", api: "invitation:withdraw" }],
            parts: [
                { slice: "invitemember", component: "InviteMemberForm", kind: "form", command: "inviteMember", gate: { action: "inviteMember" }, props: { organisationId: "route" } },
                {
                    slice: "organisationinvitations", component: "OrganisationInvitationsView", kind: "view", gate: { read: "invitation:list" }, props: { organisationId: "route" },
                    row: [{ slice: "withdrawinvitation", component: "WithdrawInvitationForm", kind: "form", gate: { action: "withdrawInvitation" }, props: { organisationId: "route", invitationId: "row" } }]
                },
                { slice: "organisationoverview", component: "OrganisationOverviewView", kind: "view", gate: { read: "organisation:read" }, props: { organisationId: "route" } }
            ]
        },
        "/organisations/new": {
            title: "Activate Organisation", context: "licensing", entity: "organisationId", shape: "new", tenant: false, reads: [], actions: [],
            parts: [{ slice: "activateorganisation", component: "ActivateOrganisationForm", kind: "form", props: {},
                next: { route: "/organisations/:organisationId/start", params: { organisationId: "command" } } }]
        },
        "/organisations": {
            title: "My Organisations", heading: "My Organisations", context: "licensing", entity: "organisationId", shape: "list", tenant: false, reads: ["self"], actions: [],
            parts: [{ slice: "myorganisations", component: "MyOrganisationsView", kind: "view", props: {},
                links: { row: dashboard, create: "/organisations/new", onlyOne: true } }]
        },
        "/get-started": {
            title: "Get Started", context: "identity", tenant: false, reads: [], actions: [],
            parts: [{ slice: "registeruser", component: "RegisterUserForm", kind: "form", props: {}, next: { route: "/organisations/new", params: {} } }]
        },
        "/my-courses": {
            title: "My Courses", context: "enrollment", tenant: false, reads: [], actions: [],
            parts: [{ slice: "mycourses", component: "MyCoursesView", kind: "view", props: { studentId: "session" } }]
        }
    }
}

const Where = () => <p data-testid="at" />

function open(at: string, { slices = parts, from = navigation, built }: { slices?: SliceParts; from?: Navigation; built?: string[] } = {}) {
    const page = (path: string): ReactNode => <ModelPage path={path} page={from.pages[path]} navigation={from} parts={slices} built={new Set([...Object.keys(slices), ...(built ?? [])])} />
    const router = createMemoryRouter(
        [
            ...Object.keys(from.pages).map((path) => ({ path, element: page(path) })),
            { path: "/organisations/:organisationId/start", element: <Where /> },
            { path: "/invitations/:invitationId", element: <Where /> }
        ],
        { initialEntries: [at] }
    )
    return router
}

/** With the stub sign-in: nothing is asked, everything is offered */
function stub(at: string, options?: Parameters<typeof open>[1], session = {}) {
    const router = open(at, options)
    render(<SessionProvider initial={session} remember={false}><RouterProvider router={router} /></SessionProvider>)
    return router
}

/** Signed in for real, holding `permissions` in org-1 (and none elsewhere) */
function holding(permissions: string[], at = "/organisations/org-1") {
    forgetPermissions()
    vi.spyOn(signInService, "useSession").mockReturnValue({ data: { user: { id: "sub-1", email: "e@example.com" } }, isPending: false } as never)
    server.use(http.get(apiUrl("/my-permissions"), ({ request }) =>
        HttpResponse.json({ permissions: new URL(request.url).searchParams.get("organisationId") === "org-1" ? permissions : [] })))
    const router = open(at)
    render(<SessionProvider mode="better-auth" remember={false}><RouterProvider router={router} /></SessionProvider>)
    return router
}

describe("a page from the model (ADR-069)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("shows its heading, then each slice's part in order, each with its ids from the route", async () => {
        stub("/organisations/org-1")
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dashboard")
        const shown = [...document.querySelectorAll("button, table, p")].map((e) => e.getAttribute("aria-label") ?? e.textContent)
        expect(shown).toEqual(["Invite to org-1", "Invitations of org-1", "Withdraw i1 from org-1", "Withdraw i2 from org-1", "Overview of org-1"])
    })

    it("puts the row's forms in each row of the list, with that row's ids", async () => {
        stub("/organisations/org-1")
        const rows = within(screen.getByRole("table")).getAllByRole("row")
        expect(within(rows[0]).getByRole("button")).toHaveTextContent("Withdraw i1 from org-1")
        expect(within(rows[1]).getByRole("button")).toHaveTextContent("Withdraw i2 from org-1")
    })

    it("shows a gated part only to who may use or read it, in the organisation of the route", async () => {
        holding(["organisation:read"])
        expect(await screen.findByText("Overview of org-1")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: /Invite/ })).not.toBeInTheDocument()
        expect(screen.queryByRole("table")).not.toBeInTheDocument()
    })

    it("shows the admin's parts to an admin, and a row's action only when it's allowed too", async () => {
        holding(["organisation:read", "invitation:create", "invitation:list"])
        expect(await screen.findByRole("button", { name: "Invite to org-1" })).toBeInTheDocument()
        expect(await screen.findByRole("table")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: /Withdraw/ })).not.toBeInTheDocument()
    })

    it("shows nothing gated until the person's permissions arrive", () => {
        holding(["organisation:read"])
        expect(screen.queryByText("Overview of org-1")).not.toBeInTheDocument()
    })

    it("passes an id from the session to a part keyed by the person", () => {
        stub("/my-courses", undefined, { studentId: "s1" })
        expect(screen.getByText("Courses of s1")).toBeInTheDocument()
    })
})

describe("where a page goes (ADR-069)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("after a form's command, goes to its next page, each id from where it comes", async () => {
        const router = stub("/organisations/new")
        await userEvent.click(screen.getByRole("button", { name: "Activate" }))
        expect(router.state.location.pathname).toBe("/organisations/o9/start")
    })

    it("stays when the command didn't give an id the next page needs", async () => {
        const router = stub("/organisations/new")
        await userEvent.click(screen.getByRole("button", { name: "Activate without an answer" }))
        expect(router.state.location.pathname).toBe("/organisations/new")
    })

    it("stays after a form without next", async () => {
        const router = stub("/organisations/org-1")
        await userEvent.click(screen.getByRole("button", { name: "Invite to org-1" }))
        expect(router.state.location.pathname).toBe("/organisations/org-1")
    })

    it("on the registration page, goes to where sign-up was going first", async () => {
        const router = stub("/get-started?next=%2Finvitations%2Fi1")
        await userEvent.click(screen.getByRole("button", { name: "Register user" }))
        expect(router.state.location.pathname).toBe("/invitations/i1")
    })

    it("on the registration page without it, goes to its next page", async () => {
        const router = stub("/get-started")
        await userEvent.click(screen.getByRole("button", { name: "Register user" }))
        expect(router.state.location.pathname).toBe("/organisations/new")
    })
})

describe("a list on an entity's list page (ADR-069)", () => {
    afterEach(() => vi.restoreAllMocks())

    it("links each row to its page and the empty state to the new one", () => {
        stub("/organisations")
        expect(screen.getByRole("link", { name: "o1" })).toHaveAttribute("href", "/organisations/o1")
        expect(screen.getByRole("link", { name: "New organisation" })).toHaveAttribute("href", "/organisations/new")
    })

    it("opens the only row of the person's own list, replacing the list", async () => {
        const one: SliceParts = { ...parts, myorganisations: { MyOrganisationsView: (p: object) => (parts.myorganisations.MyOrganisationsView as (q: object) => ReactNode)({ ...p, rows: ["o1"] }) } }
        const router = stub("/organisations", { slices: one })
        await vi.waitFor(() => expect(router.state.location.pathname).toBe("/organisations/o1"))
        expect(router.state.historyAction).toBe("REPLACE")
    })

    it("lists the one row of a list that isn't the person's own (a platform admin's every organisation)", async () => {
        const one: SliceParts = { ...parts, myorganisations: { MyOrganisationsView: (p: object) => (parts.myorganisations.MyOrganisationsView as (q: object) => ReactNode)({ ...p, rows: ["o1"] }) } }
        const every = structuredClone(navigation)
        delete every.pages["/organisations"].parts![0].links!.onlyOne
        const router = stub("/organisations", { slices: one, from: every })
        expect(await screen.findByRole("link", { name: "o1" })).toBeInTheDocument()
        expect(router.state.location.pathname).toBe("/organisations")
    })
})

describe("a part the page can't find", () => {
    it("leaves out a part whose slice isn't built yet", () => {
        const { invitemember: _notYet, ...rest } = parts
        stub("/organisations/org-1", { slices: rest })
        expect(screen.queryByRole("button", { name: /Invite/ })).not.toBeInTheDocument()
        expect(screen.getByText("Overview of org-1")).toBeInTheDocument()
    })

    it("says which built slice's index.ts doesn't export it", async () => {
        const { invitemember: _gone, ...rest } = parts
        vi.spyOn(console, "error").mockImplementation(() => {})
        vi.spyOn(console, "warn").mockImplementation(() => {})
        stub("/organisations/org-1", { slices: rest, built: ["invitemember"] })
        expect((await screen.findAllByText(/src\/slices\/invitemember\/index.ts doesn't export InviteMemberForm/)).length).toBeGreaterThan(0)
        vi.restoreAllMocks()
    })
})
