import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query"

/**
 * Lists page with "Load more" over the backend's cursor (ADR-026). A query route or a list read model answers
 * `?limit=&cursor=` with `{ data, cursor? }`; the cursor is a bookmark ("the next page starts after this row"),
 * there only while there are more rows. The list shows its first page; `fetchNextPage` adds the next one below.
 *
 *   const courses = usePagedList({
 *       queryKey: ["course-seats", "available-courses", minRemainingSeats],
 *       fetchPage: ({ limit, cursor }) =>
 *           read(api.GET("/course-seats/available-courses", {
 *               params: { query: { minRemainingSeats, limit, cursor } }, headers: afterLastWrite() }))
 *   })
 *   courses.rows … <LoadMore list={courses} />
 *
 * After a write (`recordWrite`) every loaded page is fetched again, in order.
 */

/** Rows per page: VITE_PAGE_SIZE, else 20 (the backend's own default is 50, at most 200). */
export const PAGE_SIZE = Number(import.meta.env.VITE_PAGE_SIZE) || 20

export interface Page<Row> {
    data: Row[]
    cursor?: string
}

export function usePagedList<Row>({
    queryKey,
    fetchPage
}: {
    queryKey: QueryKey
    fetchPage: (page: { limit: number; cursor?: string }) => Promise<Page<Row>>
}) {
    const list = useInfiniteQuery({
        queryKey,
        queryFn: ({ pageParam }) => fetchPage({ limit: PAGE_SIZE, cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last: Page<Row>) => last.cursor
    })
    return { ...list, rows: list.data?.pages.flatMap((page) => page.data) ?? [] }
}
