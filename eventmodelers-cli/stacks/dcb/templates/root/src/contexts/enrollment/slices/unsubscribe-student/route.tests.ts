import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureUnsubscribeStudentRoute } from "./route.js"
import { courseWasRegistered, studentWasRegistered, studentWasSubscribed, studentWasUnsubscribed } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureUnsubscribeStudentRoute({ store, pool: {} as Pool })
})

describe("DELETE /courses/:courseId/subscriptions/:studentId — unsubscribe student", () => {
    test("unsubscribes student and returns 204", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }),
                studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
            .when(agent => agent.delete("/courses/c1/subscriptions/s1"))
            .then(
                expectResponse(204),
                studentWasUnsubscribed({ courseId: "c1", studentId: "s1" })
            )
    })

    test("returns 404 when course does not exist", async () => {
        await spec
            .when(agent => agent.delete("/courses/nonexistent/subscriptions/s1"))
            .then(expectError(404))
    })

    test("returns 404 when student is not subscribed", async () => {
        await spec
            .existingEvents(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.delete("/courses/c1/subscriptions/s1"))
            .then(expectError(404))
    })
})
