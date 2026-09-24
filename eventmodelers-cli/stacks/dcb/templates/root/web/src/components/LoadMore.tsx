import { Button } from "@/components/ui/button"

/** The button under a paged list (ADR-026): shown while the backend has more rows, it adds the next page. */
export function LoadMore({
    list
}: {
    list: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown }
}) {
    if (!list.hasNextPage) return null
    return (
        <Button type="button" variant="outline" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
    )
}
