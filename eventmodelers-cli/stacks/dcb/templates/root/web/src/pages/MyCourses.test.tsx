import { render, screen } from "@testing-library/react"
import { App } from "@/App"

describe("My Courses (/my-courses)", () => {
    it("shows the signed-in student's courses", async () => {
        render(<App initialPath="/my-courses" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("navigation")).toHaveTextContent("My Courses")
        expect(await screen.findByText("Alice")).toBeInTheDocument()
        expect(screen.getByRole("listitem")).toHaveTextContent("Math")
    })
})
