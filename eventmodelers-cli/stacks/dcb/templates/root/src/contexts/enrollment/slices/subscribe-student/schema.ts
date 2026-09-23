import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { registerCommand } from "../../../../shared/openapi.js"

extendZodWithOpenApi(z)

export const SubscribeStudentSchema = z
    .object({
        studentId: z.string().min(1).openapi({ example: "student-1", description: "ID of the student to subscribe" })
    })
    .openapi("SubscribeStudentBody")

registerCommand({
    method: "post",
    path: "/courses/:courseId/subscriptions",
    summary: "Subscribe a student to a course",
    body: SubscribeStudentSchema,
    success: "createdUrl",
    errors: { 404: "Course or student not found", 422: "Course is full, or the student is already subscribed" }
})
