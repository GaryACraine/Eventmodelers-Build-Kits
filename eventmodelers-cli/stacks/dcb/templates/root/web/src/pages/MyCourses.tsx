import type { PageInfo } from "@/lib/page"
import { useSession } from "@/lib/session"
import { StudentDetailsView } from "@/slices/student-details/StudentDetailsView"

// slice.json screens[].page: "My Courses", from the slice "Student Details"; params: studentId from the session.
export const page: PageInfo = { path: "/my-courses", title: "My Courses", nav: true, session: ["studentId"] }

/** My Courses: the signed-in student's courses. */
export default function MyCourses() {
    const { studentId } = useSession()
    return (
        <>
            <h1>My courses</h1>
            <StudentDetailsView studentId={studentId} />
        </>
    )
}
