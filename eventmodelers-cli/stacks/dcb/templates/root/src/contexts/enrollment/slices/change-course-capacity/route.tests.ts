import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureChangeCourseCapacityRoute } from "./route.js"
import { courseWasRegistered, courseCapacityWasChanged } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureChangeCourseCapacityRoute({ store, pool: {} as Pool })
})

describe("PUT /courses/:courseId/capacity — change course capacity", () => {
    test("changes capacity and returns 204", async () => {
        await spec
            .existingEvents(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.put("/courses/c1/capacity").send({ newCapacity: 50 }))
            .then(
                expectResponse(204),
                courseCapacityWasChanged({ courseId: "c1", newCapacity: 50 })
            )
    })

    test("returns 404 when course does not exist", async () => {
        await spec
            .when(agent => agent.put("/courses/nonexistent/capacity").send({ newCapacity: 50 }))
            .then(expectError(404))
    })

    test("returns 422 when new capacity is the same as current", async () => {
        await spec
            .existingEvents(courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }))
            .when(agent => agent.put("/courses/c1/capacity").send({ newCapacity: 30 }))
            .then(expectError(422))
    })

    test("returns 400 when newCapacity is missing", async () => {
        await spec
            .when(agent => agent.put("/courses/c1/capacity").send({}))
            .then(expectError(400))
    })
})
