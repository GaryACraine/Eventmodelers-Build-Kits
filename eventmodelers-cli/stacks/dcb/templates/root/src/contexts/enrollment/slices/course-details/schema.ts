import { z } from "zod"
import { registerRead } from "../../../../shared/openapi.js"

export const CourseSchema = z
    .object({
        id: z.string().openapi({ example: "course-101" }),
        title: z.string().openapi({ example: "Introduction to TypeScript" }),
        capacity: z.number().int().openapi({ example: 30 }),
        subscribedStudents: z.array(
            z.object({ studentId: z.string(), name: z.string(), studentNumber: z.number().int() })
        )
    })
    .openapi("Course")

registerRead({
    path: "/course-details/:courseId",
    summary: "Get a course",
    response: CourseSchema,
    notFound: "Course not found",
    wait: true
})
