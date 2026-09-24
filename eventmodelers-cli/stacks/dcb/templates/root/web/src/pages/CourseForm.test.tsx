import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"

describe("Course Form (/courses/new)", () => {
    it("registers a course and goes to its Course Page", async () => {
        render(<App initialPath="/courses/new" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("navigation")).toHaveTextContent("Course Form")
        await userEvent.type(await screen.findByLabelText("Course ID"), "c1")
        await userEvent.type(screen.getByLabelText("Title"), "Math")
        await userEvent.type(screen.getByLabelText("Capacity"), "30")
        await userEvent.click(screen.getByRole("button", { name: "Register course" }))
        expect(await screen.findByRole("heading", { name: "Math" })).toBeInTheDocument()
    })
})
