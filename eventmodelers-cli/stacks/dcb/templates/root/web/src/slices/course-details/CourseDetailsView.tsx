import { useQuery } from "@tanstack/react-query"
import { ReadStates, Value } from "@/components/patterns"
import { api, read } from "@/lib/api"
import { useWrites } from "@/lib/writes"

/**
 * Course Details: the course on the "Course Page" screen (mockup: `section.mock-card` with `data-field="title"`
 * and `data-field="capacity"`). Reads `GET /course-details/{courseId}` (slice.json
 * `apiEndpoint`), an async read model, so it waits for the last write (a subscription shows up at once). The mockup's
 * card has the course's title as its heading, so the states go round the card (`ReadStates`), not in it.
 */
export function CourseDetailsView({ courseId }: { courseId: string }) {
    const { afterLastWrite } = useWrites()
    const course = useQuery({
        queryKey: ["course-details", courseId],
        queryFn: () => read(api.GET("/course-details/{courseId}", { params: { path: { courseId } }, headers: afterLastWrite() }))
    })
    return (
        <ReadStates read={course}>
            {({ title, capacity }) => (
                <section className="mock-card">
                    <h1>{title}</h1>
                    <p>
                        <span>
                            <Value of={capacity} type="Int" />
                        </span>{" "}
                        places
                    </p>
                </section>
            )}
        </ReadStates>
    )
}
