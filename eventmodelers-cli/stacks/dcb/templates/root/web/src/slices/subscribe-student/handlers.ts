import { http, HttpResponse } from "msw"
import { apiUrl } from "@/lib/api"

/** Mock mode: subscribing succeeds (its first scenario). The rejections are answered in the tests. */
export const handlers = [
    http.post(apiUrl("/subscribe-student-to-course"), () => new HttpResponse(null, { status: 204, headers: { ETag: '"2"' } }))
]
