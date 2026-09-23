import { registerCommand } from "../../../../shared/openapi.js"

registerCommand({
    method: "delete",
    path: "/courses/:courseId/subscriptions/:studentId",
    summary: "Unsubscribe a student from a course",
    success: "noContent",
    errors: { 404: "Course or subscription not found" }
})
