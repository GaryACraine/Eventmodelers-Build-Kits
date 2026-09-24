import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"
import { server } from "@/mocks/server"
import { renderWithProviders } from "@/test/render"
import { CourseList } from "./CourseList"

describe("Course List", () => {
    it("lists the registered courses, each linked to its page", async () => {
        renderWithProviders(<CourseList linkTo={(course) => `/courses/${course.id}`} />)
        expect(await screen.findByRole("link", { name: "Math" })).toHaveAttribute("href", "/courses/c1")
        expect(screen.getByRole("cell", { name: "30" })).toBeInTheDocument()
    })

    it("shows the first page, and Load more adds the next one below it until there are no more", async () => {
        const cursors: (string | null)[] = []
        server.use(
            http.get(apiUrl("/course-list"), ({ request }) => {
                const cursor = new URL(request.url).searchParams.get("cursor")
                cursors.push(cursor)
                return cursor === null
                    ? HttpResponse.json({ data: [{ id: "c1", title: "Math", capacity: 30, subscribedStudents: [] }], cursor: "c1" })
                    : HttpResponse.json({ data: [{ id: "c2", title: "Art", capacity: 20, subscribedStudents: [] }] })
            })
        )
        renderWithProviders(<CourseList />)
        expect(await screen.findByRole("cell", { name: "Math" })).toBeInTheDocument()
        await userEvent.click(screen.getByRole("button", { name: "Load more" }))
        expect(await screen.findByRole("cell", { name: "Art" })).toBeInTheDocument()
        expect(screen.getByRole("cell", { name: "Math" })).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument()
        expect(cursors).toEqual([null, "c1"])
    })

    it("says so when there are none", async () => {
        server.use(http.get(apiUrl("/course-list"), () => HttpResponse.json({ data: [] })))
        renderWithProviders(<CourseList />)
        expect(await screen.findByText("No courses yet.")).toBeInTheDocument()
    })
})
