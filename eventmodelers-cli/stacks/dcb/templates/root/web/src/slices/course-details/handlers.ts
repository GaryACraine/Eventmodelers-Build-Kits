import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"

/** Mock mode: the course of the scenarios (c1, Math, 30), with the student subscribed (s1, Alice). Others: 404. */
export const handlers = [
    http.get(apiUrl("/course-details/:courseId"), ({ params }) =>
        params.courseId === "c1"
            ? HttpResponse.json(
                  { id: "c1", title: "Math", capacity: 30, subscribedStudents: [{ studentId: "s1", name: "Alice", studentNumber: 1 }] },
                  { headers: { ETag: '"2"' } }
              )
            : HttpResponse.json({ status: 404, title: "Not Found", detail: "Course not found" }, { status: 404 })
    )
]
