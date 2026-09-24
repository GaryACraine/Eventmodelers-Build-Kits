import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"

// The page put together: its route, each slice's part, and where it links. Answered by the slices' handlers.

describe("Courses (/courses)", () => {
    it("is in the header, and each course links to its Course Page", async () => {
        render(<App initialPath="/courses" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("navigation")).toHaveTextContent("Courses")
        await userEvent.click(await screen.findByRole("link", { name: "Math" }))
        expect(await screen.findByRole("heading", { name: "Math" })).toBeInTheDocument()
    })
})
