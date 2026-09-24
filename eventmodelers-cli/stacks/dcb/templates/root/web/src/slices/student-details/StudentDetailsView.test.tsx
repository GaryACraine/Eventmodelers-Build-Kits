import { screen } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"
import { server } from "@/mocks/server"
import { renderWithProviders } from "@/test/render"
import { StudentDetailsView } from "./StudentDetailsView"

// Scenario examples: slice.json "Student Details".

describe("Student Details", () => {
    it("shows the student's subscribed courses", async () => {
        renderWithProviders(<StudentDetailsView studentId="s1" />)
        expect(await screen.findByText("Alice")).toBeInTheDocument()
        expect(screen.getByRole("listitem")).toHaveTextContent("Math")
    })

    it("shows no courses right after the student registered", async () => {
        server.use(
            http.get(apiUrl("/student-details/:studentId"), () =>
                HttpResponse.json({ id: "s1", name: "Alice", studentNumber: 1, subscribedCourses: [] })
            )
        )
        renderWithProviders(<StudentDetailsView studentId="s1" />)
        expect(await screen.findByText("No courses yet.")).toBeInTheDocument()
    })

    it("says so for an unknown student", async () => {
        renderWithProviders(<StudentDetailsView studentId="nobody" />)
        expect(await screen.findByRole("alert")).toHaveTextContent("Student not found")
    })
})
