import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"
import { page } from "@/mocks/paging"

/** Mock mode: the course the scenarios register (c1, Math, 30), paged like the backend. */
const courses = [{ id: "c1", title: "Math", capacity: 30, subscribedStudents: [] }]

export const handlers = [
    http.get(apiUrl("/course-list"), ({ request }) => HttpResponse.json(page(courses, request), { headers: { ETag: '"1"' } }))
]
