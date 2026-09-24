import { useNavigate } from "react-router"
import type { PageInfo } from "@/lib/page"
import { RegisterCourseForm } from "@/slices/register-course/RegisterCourseForm"

// slice.json screens[].page: "Course Form", from the slice "Register Course"
export const page: PageInfo = { path: "/courses/new", title: "Course Form", nav: true }

/** Course Form: register a course, then go to it. */
export default function CourseForm() {
    const navigate = useNavigate()
    return (
        <>
            <h1>New course</h1>
            <RegisterCourseForm onRegistered={(course) => navigate(`/courses/${encodeURIComponent(course.id)}`)} />
        </>
    )
}
