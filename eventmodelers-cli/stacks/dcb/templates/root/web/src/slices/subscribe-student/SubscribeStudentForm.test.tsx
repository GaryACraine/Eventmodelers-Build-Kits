import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"
import { server } from "@/mocks/server"
import { renderWithProviders } from "@/test/render"
import { SubscribeStudentForm } from "./SubscribeStudentForm"

// Scenario examples: slice.json "Subscribe Student" (course c1, student s1).

function rejectWith(status: number, detail: string) {
    server.use(
        http.post(apiUrl("/subscribe-student-to-course"), () =>
            HttpResponse.json({ status, title: status === 404 ? "Not Found" : "Unprocessable Entity", detail }, { status })
        )
    )
}

async function subscribe(courseId = "c1") {
    renderWithProviders(<SubscribeStudentForm courseId={courseId} />, { session: { studentId: "s1" } })
    await userEvent.click(screen.getByRole("button", { name: "Subscribe" }))
}

describe("Subscribe Student", () => {
    it("subscribes the signed-in student to the page's course", async () => {
        let body: unknown
        server.use(
            http.post(apiUrl("/subscribe-student-to-course"), async ({ request }) => {
                body = await request.json()
                return new HttpResponse(null, { status: 204, headers: { ETag: '"2"' } })
            })
        )
        await subscribe()
        expect(await screen.findByRole("status")).toHaveTextContent("You're subscribed.")
        expect(body).toEqual({ courseId: "c1", studentId: "s1" })
    })

    it("shows the rejection when the course doesn't exist", async () => {
        rejectWith(404, "Course nonexistent doesn't exist.")
        await subscribe("nonexistent")
        expect(await screen.findByRole("alert")).toHaveTextContent("Course nonexistent doesn't exist.")
    })

    it("shows the rejection when the course is full", async () => {
        rejectWith(422, "Course c1 is full.")
        await subscribe()
        expect(await screen.findByRole("alert")).toHaveTextContent("Course c1 is full.")
    })

    it("shows the rejection when the student is already subscribed", async () => {
        rejectWith(422, "Student s1 already subscribed to course c1.")
        await subscribe()
        expect(await screen.findByRole("alert")).toHaveTextContent("Student s1 already subscribed to course c1.")
    })

    // "returns 400 when studentId is missing": the page can't send one without it (RequireSession asks first).
})
