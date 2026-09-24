import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"

describe("Course Page (/courses/:courseId)", () => {
    it("shows the course from its route, and subscribes the signed-in student", async () => {
        render(<App initialPath="/courses/c1" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("heading", { name: "Math" })).toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Subscribe" }))
        expect(await screen.findByRole("status")).toHaveTextContent("You're subscribed.")
    })

    it("asks who you are first (studentId comes from the session), and isn't in the header", async () => {
        render(<App initialPath="/courses/c1" />)
        expect(await screen.findByRole("navigation")).not.toHaveTextContent("Course Page")
        await userEvent.type(await screen.findByLabelText("Student ID"), "s1")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(await screen.findByRole("heading", { name: "Math" })).toBeInTheDocument()
    })
})
