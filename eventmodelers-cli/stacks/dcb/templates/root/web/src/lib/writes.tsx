import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { afterWrite } from "./api"

/**
 * Read-your-writes across the app. After a command succeeds, its form calls `recordWrite(position)`: the app
 * remembers the event store position it reached and refetches every view on screen.
 *
 * A view of an **async** (`database-projected`) read model sends `afterLastWrite()` as its headers, so the
 * backend waits until the read model has caught up with that write. A view of an `inline-projected` or
 * `live-report` read model never sends it: it's already current when the command returns.
 *
 *   const { recordWrite } = useWrites()
 *   const { position } = await command(api.POST("/subscribe-student", { body }))
 *   await recordWrite(position)
 *
 *   const { afterLastWrite } = useWrites()
 *   useQuery({ queryKey: ["course-seats", "available-courses"],
 *              queryFn: () => read(api.GET("/course-seats/available-courses", { params, headers: afterLastWrite() })) })
 */
interface Writes {
    recordWrite: (position: string | undefined) => Promise<void>
    afterLastWrite: () => Record<string, string>
}

const WritesContext = createContext<Writes | undefined>(undefined)

export function WritesProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient()
    // A ref, not state: a refetch reads the position at fetch time, not at the last render.
    const last = useRef<string | undefined>(undefined)
    const recordWrite = useCallback(
        async (position: string | undefined) => {
            if (position) last.current = position
            await queryClient.invalidateQueries()
        },
        [queryClient]
    )
    const afterLastWrite = useCallback(() => afterWrite(last.current), [])
    const writes = useMemo(() => ({ recordWrite, afterLastWrite }), [recordWrite, afterLastWrite])
    return <WritesContext.Provider value={writes}>{children}</WritesContext.Provider>
}

export function useWrites(): Writes {
    const writes = useContext(WritesContext)
    if (!writes) throw new Error("useWrites needs a WritesProvider (App provides it)")
    return writes
}
