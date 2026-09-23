import { z } from "zod"
import { registerRead } from "../../../../shared/openapi.js"

export const StudentSchema = z
    .object({
        id: z.string().openapi({ example: "student-1" }),
        name: z.string().openapi({ example: "Alice" }),
        studentNumber: z.number().int().openapi({ example: 1 }),
        subscribedCourses: z.array(z.object({ courseId: z.string(), title: z.string(), capacity: z.number().int() }))
    })
    .openapi("Student")

registerRead({
    path: "/students/:studentId",
    summary: "Get a student",
    response: StudentSchema,
    notFound: "Student not found",
    wait: true
})
