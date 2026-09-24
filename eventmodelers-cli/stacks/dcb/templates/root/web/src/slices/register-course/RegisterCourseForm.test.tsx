import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"
import { server } from "@/mocks/server"
import { renderWithProviders } from "@/test/render"
import { RegisterCourseForm } from "./RegisterCourseForm"

// Scenario examples: slice.json "Register Course" (c1, Math, 30).

function renderForm(onRegistered = vi.fn()) {
    renderWithProviders(<RegisterCourseForm onRegistered={onRegistered} />)
    return onRegistered
}

async function fill({ id, title, capacity }: { id?: string; title?: string; capacity?: string }) {
    if (id) await userEvent.type(screen.getByLabelText("Course ID"), id)
    if (title) await userEvent.type(screen.getByLabelText("Title"), title)
    if (capacity) await userEvent.type(screen.getByLabelText("Capacity"), capacity)
    await userEvent.click(screen.getByRole("button", { name: "Register course" }))
}

describe("Register Course", () => {
    it("registers a new course", async () => {
        let body: unknown
        server.use(
            http.post(apiUrl("/register-course"), async ({ request }) => {
                body = await request.json()
                return new HttpResponse(null, { status: 204, headers: { ETag: '"1"' } })
            })
        )
        const onRegistered = renderForm()
        await fill({ id: "c1", title: "Math", capacity: "30" })
        await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledWith({ id: "c1", title: "Math", capacity: 30 }))
        expect(body).toEqual({ id: "c1", title: "Math", capacity: 30 })
    })

    it("shows the rejection when the course already exists", async () => {
        server.use(
            http.post(apiUrl("/register-course"), () =>
                HttpResponse.json(
                    { status: 422, title: "Unprocessable Entity", detail: "Course with id c1 already exists" },
                    { status: 422 }
                )
            )
        )
        const onRegistered = renderForm()
        await fill({ id: "c1", title: "Math", capacity: "30" })
        expect(await screen.findByRole("alert")).toHaveTextContent("Course with id c1 already exists")
        expect(onRegistered).not.toHaveBeenCalled()
    })

    it("asks for the capacity when it's missing, without sending", async () => {
        const onRegistered = renderForm()
        await fill({ id: "c1", title: "Math" })
        expect(await screen.findByText("Required")).toBeInTheDocument()
        expect(onRegistered).not.toHaveBeenCalled()
    })

    it("refuses a capacity of zero, without sending", async () => {
        const onRegistered = renderForm()
        await fill({ id: "c1", title: "Math", capacity: "0" })
        expect(await screen.findByText("At least 1")).toBeInTheDocument()
        expect(onRegistered).not.toHaveBeenCalled()
    })
})
