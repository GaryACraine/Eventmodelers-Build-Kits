import { generatePath } from "react-router"
import type { PageInfo } from "@/lib/page"
import { CourseList } from "@/slices/course-list/CourseList"

// slice.json screens[].page: "Courses", from the slice "Course List"
export const page: PageInfo = { path: "/courses", title: "Courses", nav: true }

/** Courses: every course, each linked to its Course Page (joined by the course's ID). */
export default function Courses() {
    return (
        <>
            <h1>Courses</h1>
            <CourseList linkTo={(course) => generatePath("/courses/:courseId", { courseId: course.id })} />
        </>
    )
}
