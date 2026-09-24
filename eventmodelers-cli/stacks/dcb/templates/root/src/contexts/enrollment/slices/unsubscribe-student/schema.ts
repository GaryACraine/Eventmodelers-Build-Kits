import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { registerCommand } from "../../../../shared/openapi.js"

extendZodWithOpenApi(z)

export const UnsubscribeStudentSchema = z
    .object({
        courseId: z.string().min(1).openapi({ example: "course-101", description: "ID of the course" }),
        studentId: z.string().min(1).openapi({ example: "student-1", description: "ID of the student to unsubscribe" })
    })
    .openapi("UnsubscribeStudentBody")

registerCommand({
    method: "post",
    path: "/unsubscribe-student-from-course",
    summary: "Unsubscribe a student from a course",
    body: UnsubscribeStudentSchema,
    success: "noContent",
    errors: { 404: "Course or subscription not found" }
})
