import { screen } from "@testing-library/react"
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

    it("says so when there are none", async () => {
        server.use(http.get(apiUrl("/course-list"), () => HttpResponse.json({ data: [] })))
        renderWithProviders(<CourseList />)
        expect(await screen.findByText("No courses yet.")).toBeInTheDocument()
    })
})
