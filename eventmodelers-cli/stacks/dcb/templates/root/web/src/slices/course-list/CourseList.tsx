import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router"
import { api, read } from "@/lib/api"
import type { components } from "@/lib/api-types"
import { useWrites } from "@/lib/writes"

type Course = components["schemas"]["Course"]

/**
 * Course List: the rows of the "Courses" screen (mockup: `table data-list="CourseList"`). Reads `GET /course-list`
 * (slice.json `apiEndpoint`), an async read model, so it waits for the last write. `linkTo` (from the page) makes
 * each row a link to the course.
 */
export function CourseList({ linkTo }: { linkTo?: (course: Course) => string }) {
    const { afterLastWrite } = useWrites()
    const courses = useQuery({
        queryKey: ["course-list"],
        queryFn: () => read(api.GET("/course-list", { headers: afterLastWrite() }))
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
                    {courses.data.data.map((course) => (
                        <tr key={course.id}>
                            <td>{linkTo ? <Link to={linkTo(course)}>{course.title}</Link> : course.title}</td>
                            <td>{course.capacity}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {courses.data.data.length === 0 && <p className="text-sm text-muted-foreground">No courses yet.</p>}
        </section>
    )
}
