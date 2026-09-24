import { useParams } from "react-router"
import type { PageInfo } from "@/lib/page"
import { CourseDetailsView } from "@/slices/course-details/CourseDetailsView"
import { SubscribeStudentForm } from "@/slices/subscribe-student/SubscribeStudentForm"

// slice.json screens[].page: "Course Page", from the slices "Course Details" and "Subscribe Student";
// params: courseId from the route, studentId from the session.
export const page: PageInfo = { path: "/courses/:courseId", title: "Course Page", session: ["studentId"] }

/** Course Page: the course, and the signed-in student subscribing to it. Each slice's part, in timeline order. */
export default function CoursePage() {
    const { courseId } = useParams<"courseId">()
    return (
        <>
            <CourseDetailsView courseId={courseId!} />
            <SubscribeStudentForm courseId={courseId!} />
        </>
    )
}
