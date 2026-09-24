import { useQuery } from "@tanstack/react-query"
import { api, read } from "@/lib/api"
import { useWrites } from "@/lib/writes"

/**
 * Course Details: the course on the "Course Page" screen (mockup: `section.mock-card` with `data-field="title"`
 * and `data-field="capacity"`). Reads `GET /course-details/{courseId}` (slice.json
 * `apiEndpoint`), an async read model, so it waits for the last write (a subscription shows up at once).
 */
export function CourseDetailsView({ courseId }: { courseId: string }) {
    const { afterLastWrite } = useWrites()
    const course = useQuery({
        queryKey: ["course-details", courseId],
        queryFn: () => read(api.GET("/course-details/{courseId}", { params: { path: { courseId } }, headers: afterLastWrite() }))
    })
    if (course.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>
    if (course.isError) return <p role="alert">{course.error.message}</p>

    const { title, capacity } = course.data
    return (
        <section className="mock-card">
            <h1>{title}</h1>
            <p>
                <span>{capacity}</span> places
            </p>
        </section>
    )
}
