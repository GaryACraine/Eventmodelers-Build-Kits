import { handle } from "@dcb-es/event-store"
import { on, NoContent, withETag, getIdempotencyKey, validateBody, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { subscribeStudentToCourse } from "./decider.js"
import { SubscribeStudentSchema } from "./schema.js"

export function configureSubscribeStudentRoute(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.post(
            "/subscribe-student-to-course",
            validateBody(SubscribeStudentSchema),
            on(async req => {
                const { courseId, studentId } = req.body
                const idempotencyKey = getIdempotencyKey(req)
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                const position =
                    existingPosition ??
                    (await handle(
                        store,
                        subscribeStudentToCourse,
                        { type: "subscribeStudentToCourse", data: { courseId, studentId } },
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
