import { handle } from "@dcb-es/event-store"
import { on, NoContent, withETag, getIdempotencyKey, validateBody, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { unsubscribeStudentFromCourse } from "./decider.js"
import { UnsubscribeStudentSchema } from "./schema.js"

export function configureUnsubscribeStudentRoute(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.post(
            "/unsubscribe-student-from-course",
            validateBody(UnsubscribeStudentSchema),
            on(async req => {
                const { courseId, studentId } = req.body
                const idempotencyKey = getIdempotencyKey(req)
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                const position =
                    existingPosition ??
                    (await handle(
                        store,
                        unsubscribeStudentFromCourse,
                        { type: "unsubscribeStudentFromCourse", data: { courseId, studentId } },
                        { idempotencyKey }
                    ))
                return res => {
                    withETag(position)(res)
                    NoContent()(res)
                }
            })
        )
    }
}
