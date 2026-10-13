import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "./App"

// The example's pages come from src/navigation.json (ADR-069): each slice's part, put on its page by ModelPage.
// start-empty.sh removes them with the example; a project's own come from its model's export.
describe("the example's pages, from the model", () => {
    it("Course Page: the course from its route, and the signed-in student subscribing to it", async () => {
        render(<App initialPath="/courses/c1" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("heading", { name: "Math" })).toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Subscribe" }))
        expect(await screen.findByRole("status")).toHaveTextContent("You're subscribed.")
    })

    it("Course Page asks who you are first (studentId comes from the session)", async () => {
        render(<App initialPath="/courses/c1" />)
        await userEvent.type(await screen.findByLabelText("Student ID"), "s1")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(await screen.findByRole("heading", { name: "Math" })).toBeInTheDocument()
    })

    it("My Courses: its heading, and the signed-in student's courses", async () => {
        render(<App initialPath="/my-courses" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("heading", { level: 1, name: "My courses" })).toBeInTheDocument()
        expect(await screen.findByText("Alice")).toBeInTheDocument()
    })

    it("Courses and Course Form are in the menu", async () => {
        render(<App initialPath="/courses" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("heading", { level: 1, name: "Courses" })).toBeInTheDocument()
        expect(await screen.findByRole("link", { name: "Course Form" })).toHaveAttribute("href", "/courses/new")
    })
})
