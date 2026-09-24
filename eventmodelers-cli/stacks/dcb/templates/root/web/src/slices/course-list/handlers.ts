import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"

/** Mock mode: the course the scenarios register (c1, Math, 30). */
export const handlers = [
    http.get(apiUrl("/course-list"), () =>
        HttpResponse.json({ data: [{ id: "c1", title: "Math", capacity: 30, subscribedStudents: [] }] }, { headers: { ETag: '"1"' } })
    )
]
