import { useQuery } from "@tanstack/react-query"
import { EmptyState, ViewCard } from "@/components/patterns"
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
    return (
        <ViewCard read={student}>
            {({ name, subscribedCourses }) => (
                <>
                    <p>
                        Signed in as <strong>{name}</strong>
                    </p>
                    {subscribedCourses.length === 0 ? (
                        <EmptyState empty={{ message: "No courses yet.", action: { label: "Find a course", to: "/courses" } }} />
                    ) : (
                        <ul>
                            {subscribedCourses.map((course) => (
                                <li key={course.courseId}>{course.title}</li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </ViewCard>
    )
}
