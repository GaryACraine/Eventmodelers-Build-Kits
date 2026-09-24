import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"

/** Mock mode: the student of the scenarios (s1, Alice), subscribed to c1. Others: 404. */
export const handlers = [
    http.get(apiUrl("/student-details/:studentId"), ({ params }) =>
        params.studentId === "s1"
            ? HttpResponse.json(
                  { id: "s1", name: "Alice", studentNumber: 1, subscribedCourses: [{ courseId: "c1", title: "Math", capacity: 30 }] },
                  { headers: { ETag: '"2"' } }
              )
            : HttpResponse.json({ status: 404, title: "Not Found", detail: "Student not found" }, { status: 404 })
    )
]
