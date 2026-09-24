import { Link } from "react-router"
import { LoadMore } from "@/components/LoadMore"
import { api, read } from "@/lib/api"
import type { components } from "@/lib/api-types"
import { usePagedList } from "@/lib/paging"
import { useWrites } from "@/lib/writes"

type Course = components["schemas"]["Course"]

/**
 * Course List: the rows of the "Courses" screen (mockup: `table data-list="CourseList"`). Reads `GET /course-list`
 * (slice.json `apiEndpoint`), a page at a time with Load more (ADR-026). An async read model, so each page waits for
 * the last write. `linkTo` (from the page) makes each row a link to the course.
 */
export function CourseList({ linkTo }: { linkTo?: (course: Course) => string }) {
    const { afterLastWrite } = useWrites()
    const courses = usePagedList({
        queryKey: ["course-list"],
        fetchPage: ({ limit, cursor }) =>
            read(api.GET("/course-list", { params: { query: { limit: String(limit), cursor } }, headers: afterLastWrite() }))
    })
    if (courses.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>
    if (courses.isError) return <p role="alert">{courses.error.message}</p>

    return (
        <section className="mock-card">
            <table>
                <thead>
                    <tr>
                        <th>Course</th>
                        <th>Capacity</th>
                    </tr>
                </thead>
                <tbody>
                    {courses.rows.map((course) => (
                        <tr key={course.id}>
                            <td>{linkTo ? <Link to={linkTo(course)}>{course.title}</Link> : course.title}</td>
                            <td>{course.capacity}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {courses.rows.length === 0 && <p className="text-sm text-muted-foreground">No courses yet.</p>}
            <LoadMore list={courses} />
        </section>
    )
}
