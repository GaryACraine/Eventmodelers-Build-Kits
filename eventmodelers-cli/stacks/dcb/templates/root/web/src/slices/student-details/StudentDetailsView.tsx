import { useQuery } from "@tanstack/react-query"
import { api, read } from "@/lib/api"
import { useWrites } from "@/lib/writes"

/**
 * Student Details: the "My Courses" screen (mockup: `data-field="name"` and `data-list="subscribedCourses"`).
 * Reads `GET /student-details/{studentId}` (slice.json `apiEndpoint`), an async read model, so it waits for the
 * last write. The page passes the signed-in student's id.
 */
export function StudentDetailsView({ studentId }: { studentId: string }) {
    const { afterLastWrite } = useWrites()
    const student = useQuery({
        queryKey: ["student-details", studentId],
        queryFn: () => read(api.GET("/student-details/{studentId}", { params: { path: { studentId } }, headers: afterLastWrite() }))
    })
    if (student.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>
    if (student.isError) return <p role="alert">{student.error.message}</p>

    const { name, subscribedCourses } = student.data
    return (
        <section className="mock-card">
            <p>
                Signed in as <strong>{name}</strong>
            </p>
            <ul>
                {subscribedCourses.map((course) => (
                    <li key={course.courseId}>{course.title}</li>
                ))}
            </ul>
            {subscribedCourses.length === 0 && <p className="text-sm text-muted-foreground">No courses yet.</p>}
        </section>
    )
}
