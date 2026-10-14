import { useState } from "react"
import { fireEvent, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiError, errorText, SOMETHING_WENT_WRONG, STILL_UPDATING } from "@/lib/api"
import { renderWithProviders } from "@/test/render"
import { ChoiceGroup, DataTable, Field, FormCard, formatValue, RowAction, SummaryList, Value, ViewCard, type ReadState } from "."

// The kit's patterns (ADR-072), each held to its authority's rule: GOV.UK, NN/g, WCAG 2.2.

const pending: ReadState<unknown> = { isPending: true, isError: false, error: null }
const failed = (error: Error): ReadState<unknown> => ({ isPending: false, isError: true, error })
const loaded = <T,>(data: T): ReadState<T> => ({ isPending: false, isError: false, error: null, data })

describe("errorText: one wording for failures", () => {
    it("gives a rejection's own words, and never an exception's", () => {
        expect(errorText(new ApiError(422, { detail: "The owner can't be removed" }))).toBe("The owner can't be removed")
        expect(errorText(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(SOMETHING_WENT_WRONG)
        expect(errorText("boom")).toBe(SOMETHING_WENT_WRONG)
    })
})

describe("ViewCard: a read's states, in one order", () => {
    const card = (read: ReadState<{ name: string }>, more: Partial<Parameters<typeof ViewCard>[0]> = {}) =>
        renderWithProviders(
            <ViewCard title="Organisation" read={read} {...more}>
                {(data) => <p>{(data as { name: string }).name}</p>}
            </ViewCard>
        )

    it("says it's loading as a status message, never an alert (WCAG 4.1.3)", () => {
        card(pending as ReadState<{ name: string }>)
        expect(screen.getByRole("heading", { name: "Organisation" })).toBeInTheDocument()
        expect(screen.getByRole("status")).toHaveTextContent("Loading…")
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("shows a 404 as the empty state, with its way forward (NN/g), when the view has one", () => {
        card(failed(new ApiError(404, { detail: "Not found" })) as ReadState<{ name: string }>, {
            empty: { message: "You don't belong to an organisation yet.", action: { label: "New organisation", to: "/organisations/new" } }
        })
        expect(screen.getByText(/You don't belong to an organisation yet/)).toBeInTheDocument()
        expect(screen.getByRole("link", { name: "New organisation" })).toHaveAttribute("href", "/organisations/new")
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("shows a 404 as an alert when the view has no empty state", () => {
        card(failed(new ApiError(404, { detail: "Organisation not found" })) as ReadState<{ name: string }>)
        expect(screen.getByRole("alert")).toHaveTextContent("Organisation not found")
    })

    it("shows any other failure as an alert in words a person can act on", () => {
        card(failed(new TypeError("x is undefined")) as ReadState<{ name: string }>)
        expect(screen.getByRole("alert")).toHaveTextContent(SOMETHING_WENT_WRONG)
    })

    it("shows a read model still catching up as a status, not an error", () => {
        card(failed(new ApiError(504, undefined)) as ReadState<{ name: string }>)
        expect(screen.getByRole("status")).toHaveTextContent(STILL_UPDATING)
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("shows the data, or the empty state when the data is empty", () => {
        card(loaded({ name: "Acme" }))
        expect(screen.getByText("Acme")).toBeInTheDocument()
        card(loaded({ name: "" }), { empty: { message: "Nothing yet." }, isEmpty: (d) => !(d as { name: string }).name })
        expect(screen.getByText("Nothing yet.")).toBeInTheDocument()
    })
})

describe("FormCard: the error first, sending shown, confirm when the model says so", () => {
    function Form({ confirm, fail }: { confirm?: boolean; fail?: boolean }) {
        const [error, setError] = useState<string>()
        const [sent, setSent] = useState(0)
        return (
            <FormCard
                title="Remove member"
                submit="Remove"
                pending={false}
                error={error}
                done={sent > 0 && `Sent ${sent}`}
                confirm={confirm ? { question: "Remove alex@example.com?", consequence: "They lose access at once.", confirm: "Remove member" } : undefined}
                onSubmit={(e) => {
                    e.preventDefault()
                    if (fail) setError("The owner can't be removed")
                    else setSent((n) => n + 1)
                }}
            />
        )
    }

    it("puts the error under the heading, before the button, and moves focus to it (GOV.UK error summary)", async () => {
        renderWithProviders(<Form fail />)
        await userEvent.click(screen.getByRole("button", { name: "Remove" }))
        const alert = screen.getByRole("alert")
        expect(alert).toHaveTextContent("The owner can't be removed")
        expect(alert).toHaveFocus()
        expect(alert.compareDocumentPosition(screen.getByRole("button", { name: "Remove" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it("disables the button and says it's sending while pending", () => {
        renderWithProviders(<FormCard submit="Send" pending onSubmit={() => {}} />)
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
        expect(screen.getByRole("status")).toHaveTextContent("Sending…")
    })

    it("puts what the mockup draws under the button after it (another system's frame)", () => {
        renderWithProviders(
            <FormCard submit="Start my free trial" pending={false} onSubmit={() => {}} after={<div data-testid="frame" />}>
                <p>Above</p>
            </FormCard>
        )
        const button = screen.getByRole("button", { name: "Start my free trial" })
        expect(button.compareDocumentPosition(screen.getByTestId("frame")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(button.compareDocumentPosition(screen.getByText("Above")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    })

    it("is named by its heading, or by its label when it has none (a form landmark)", () => {
        renderWithProviders(<FormCard title="Email changed" submit="Use this address" pending={false} onSubmit={() => {}} />)
        expect(screen.getByRole("form", { name: "Email changed" })).toBeInTheDocument()
        renderWithProviders(<FormCard label="Subscribe" submit="Subscribe" pending={false} onSubmit={() => {}} />)
        expect(screen.getByRole("form", { name: "Subscribe" })).toBeInTheDocument()
    })

    it("asks first when confirmed, names the outcome, and sends only once confirmed (NN/g)", async () => {
        renderWithProviders(<Form confirm />)
        await userEvent.click(screen.getByRole("button", { name: "Remove" }))
        expect(screen.getByText("Remove alex@example.com?").parentElement).toHaveFocus()
        expect(screen.queryByText(/^Sent/)).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(screen.queryByText(/^Sent/)).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Remove" }))
        await userEvent.click(screen.getByRole("button", { name: "Remove member" }))
        expect(screen.getByRole("status")).toHaveTextContent("Sent 1")
    })
})

describe("Field and ChoiceGroup: errors named by their inputs (GOV.UK; WCAG 3.3.1)", () => {
    it("labels the input, and links its hint and error to it", () => {
        renderWithProviders(<Field id="invite-email" label="Email" hint="Their work address" error="Email is required" type="email" />)
        const input = screen.getByLabelText("Email")
        expect(input).toHaveAttribute("aria-invalid", "true")
        expect(input).toHaveAccessibleDescription("Their work address Email is required")
    })

    it("isn't invalid without an error", () => {
        renderWithProviders(<Field id="invite-email" label="Email" />)
        expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid")
        expect(screen.getByLabelText("Email")).not.toHaveAccessibleDescription()
    })

    it("draws a select with its options", () => {
        renderWithProviders(
            <Field id="rate-rating" label="Rating" control="select" defaultValue="3">
                <option value="3">3</option>
            </Field>
        )
        expect(screen.getByRole("combobox", { name: "Rating" })).toHaveValue("3")
    })

    it("groups choices under their question, each labelled, the error named by the group", () => {
        renderWithProviders(
            <ChoiceGroup id="invite-roles" legend="Roles" type="checkbox" error="Choose a role" name="roleIds"
                         options={[{ value: "admin", label: "Admin" }, { value: "engineer", label: "Engineer" }]} />
        )
        const group = screen.getByRole("group", { name: "Roles" })
        expect(group).toHaveAccessibleDescription("Choose a role")
        expect(screen.getByRole("checkbox", { name: "Engineer" })).toHaveAttribute("value", "engineer")
    })
})

describe("SummaryList: key facts", () => {
    it("is a description list, one key and value per row, in order", () => {
        renderWithProviders(<SummaryList rows={[["Name", "Acme"], ["Status", "Trial"]]} />)
        const terms = screen.getAllByRole("term").map((t) => t.textContent)
        expect(terms).toEqual(["Name", "Status"])
        expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual(["Acme", "Trial"])
    })
})

describe("DataTable and RowAction: rows named, actions named by their row (GOV.UK)", () => {
    type Member = { userId: string; email: string; roles: string }
    const members: Member[] = [
        { userId: "u1", email: "alex@example.com", roles: "engineer" },
        { userId: "u2", email: "sam@example.com", roles: "admin" }
    ]
    function Remove({ onAct, confirm }: { onAct: () => void; confirm?: boolean }) {
        return (
            <RowAction action="Remove" pending={false} onAct={onAct}
                       confirm={confirm ? { consequence: "They lose access at once.", confirm: "Remove member" } : undefined} />
        )
    }
    const table = (actions?: (m: Member) => React.ReactNode, linkTo?: (m: Member) => string) =>
        renderWithProviders(
            <DataTable rows={members} rowKey={(m) => m.userId} linkTo={linkTo} actions={actions}
                       columns={[{ header: "Email", cell: (m) => m.email }, { header: "Roles", cell: (m) => m.roles }]} />
        )

    it("names each row by its first cell, and links it to its page", () => {
        table(undefined, (m) => `/members/${m.userId}`)
        expect(screen.getByRole("rowheader", { name: "alex@example.com" })).toBeInTheDocument()
        expect(screen.getByRole("link", { name: "alex@example.com" })).toHaveAttribute("href", "/members/u1")
        expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument()
    })

    it("names the actions column, and each action by its row, so rows' buttons are told apart", async () => {
        const acted: string[] = []
        table((m) => <Remove onAct={() => acted.push(m.userId)} />)
        expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Remove sam@example.com" }))
        expect(acted).toEqual(["u2"])
    })

    it("asks first, naming the row, when the command is confirmed; Cancel returns to the button", async () => {
        const acted: string[] = []
        table((m) => <Remove confirm onAct={() => acted.push(m.userId)} />)
        await userEvent.click(screen.getByRole("button", { name: "Remove alex@example.com" }))
        expect(screen.getByText("Remove alex@example.com?").parentElement).toHaveFocus()
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(acted).toEqual([])
        expect(screen.getByRole("button", { name: "Remove alex@example.com" })).toHaveFocus()
        await userEvent.click(screen.getByRole("button", { name: "Remove alex@example.com" }))
        fireEvent.click(screen.getByRole("button", { name: "Remove member" }))
        expect(acted).toEqual(["u1"])
    })

    it("shows the empty state instead of an empty table", () => {
        renderWithProviders(<DataTable rows={[]} rowKey={() => ""} columns={[{ header: "Email", cell: () => "" }]} empty={{ message: "Nobody is invited yet." }} />)
        expect(screen.getByText("Nobody is invited yet.")).toBeInTheDocument()
        expect(screen.queryByRole("table")).not.toBeInTheDocument()
    })
})

describe("Value: one type, one way of showing it", () => {
    it("shows dates and times in the locale, never as ISO strings", () => {
        expect(formatValue("2026-10-13T09:30:00Z", { type: "DateTime", locale: "en-GB" })).toMatch(/13 Oct 2026/)
        expect(formatValue("2026-10-13", { type: "Date", locale: "en-GB" })).toBe("13 Oct 2026")
        expect(formatValue("soon", { type: "Date" })).toBe("soon")
    })

    it("shows money with its currency, yes or no, numbers grouped, and codes by their labels", () => {
        expect(formatValue(1234.5, { type: "Money", currency: "GBP", locale: "en-GB" })).toBe("£1,234.50")
        expect(formatValue(true, { type: "Boolean" })).toBe("Yes")
        expect(formatValue(12000, { type: "Int", locale: "en-GB" })).toBe("12,000")
        expect(formatValue("engineer", { labels: { engineer: "Engineer" } })).toBe("Engineer")
        expect(formatValue("viewer", { labels: { engineer: "Engineer" } })).toBe("viewer")
        expect(formatValue(null)).toBe("")
    })

    it("shows a list as a list", () => {
        renderWithProviders(<Value of={["web", "mobile"]} labels={{ web: "Web", mobile: "Mobile" }} />)
        expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Web", "Mobile"])
    })
})
