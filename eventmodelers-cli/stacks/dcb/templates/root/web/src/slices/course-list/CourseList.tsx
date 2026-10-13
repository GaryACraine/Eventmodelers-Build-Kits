import { DataTable, Value, ViewCard } from "@/components/patterns"
import { api, read } from "@/lib/api"
import type { ViewPart } from "@/lib/parts"
import type { components } from "@/lib/api-types"
import { usePagedList } from "@/lib/paging"
import { useWrites } from "@/lib/writes"

type Course = components["schemas"]["Course"]

/**
 * Course List: the rows of the "Courses" screen (mockup: `table data-list="CourseList"`). Reads `GET /course-list`
 * (slice.json `apiEndpoint`), a page at a time with Load more (ADR-026). An async read model, so each page waits for
 * the last write. The page's `linkTo` makes each row a link to the course, `row` puts another slice's action in each
 * row, and `createPath` is where the empty state leads (ADR-069).
 */
export function CourseList({ linkTo, row, createPath }: ViewPart<Course>) {
    const { afterLastWrite } = useWrites()
    const courses = usePagedList({
        queryKey: ["course-list"],
        fetchPage: ({ limit, cursor }) =>
            read(api.GET("/course-list", { params: { query: { limit: String(limit), cursor } }, headers: afterLastWrite() }))
    })
    return (
        <ViewCard read={courses}>
            {() => (
                <DataTable
                    rows={courses.rows}
                    rowKey={(course) => course.id}
                    columns={[
                        { header: "Course", cell: (course) => course.title },
                        { header: "Capacity", cell: (course) => <Value of={course.capacity} type="Int" /> }
                    ]}
                    linkTo={linkTo}
                    actions={row}
                    empty={{ message: "No courses yet.", action: createPath ? { label: "New course", to: createPath } : undefined }}
                    more={courses}
                />
            )}
        </ViewCard>
    )
}
