import { screen } from "@testing-library/react"
import { renderWithProviders } from "@/test/render"
import { CourseDetailsView } from "./CourseDetailsView"

// Scenario examples: slice.json "Course Details".

describe("Course Details", () => {
    it("shows the course after it was registered", async () => {
        renderWithProviders(<CourseDetailsView courseId="c1" />)
        expect(await screen.findByRole("heading", { name: "Math" })).toBeInTheDocument()
        expect(screen.getByText("30")).toBeInTheDocument()
    })

    it("says so for an unknown course", async () => {
        renderWithProviders(<CourseDetailsView courseId="nonexistent" />)
        expect(await screen.findByRole("alert")).toHaveTextContent("Course not found")
    })
})
