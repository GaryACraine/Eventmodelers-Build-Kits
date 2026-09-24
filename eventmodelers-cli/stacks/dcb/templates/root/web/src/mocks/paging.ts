/**
 * Pages a handler's scenario rows the way the backend does (ADR-023, ADR-026): `?limit` (default 50, at most 200)
 * and an opaque `?cursor`, answering `{ data, cursor? }` with a cursor only while there are more rows.
 *
 *   http.get(apiUrl("/course-seats/available-courses"), ({ request }) => HttpResponse.json(page(rows, request)))
 */
export function page<Row>(rows: Row[], request: Request): { data: Row[]; cursor?: string } {
    const url = new URL(request.url)
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200)
    const start = Number(url.searchParams.get("cursor")) || 0
    const data = rows.slice(start, start + limit)
    return { data, ...(start + limit < rows.length && { cursor: String(start + limit) }) }
}
