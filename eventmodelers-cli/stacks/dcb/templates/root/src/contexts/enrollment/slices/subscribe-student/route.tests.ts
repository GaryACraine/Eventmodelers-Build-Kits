import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureSubscribeStudentRoute } from "./route.js"
import { courseWasRegistered, studentWasRegistered, studentWasSubscribed } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureSubscribeStudentRoute({ store, pool: {} as Pool })
})

describe("POST /subscribe-student-to-course — subscribe student", () => {
    test("subscribes student and returns 204", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }),
                studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })
            )
            .when(agent => agent.post("/subscribe-student-to-course").send({ courseId: "c1", studentId: "s1" }))
            .then(
                expectResponse(204),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
    })

    test("returns 404 when course does not exist", async () => {
        await spec
            .when(agent => agent.post("/subscribe-student-to-course").send({ courseId: "nonexistent", studentId: "s1" }))
            .then(expectError(404))
    })

    test("returns 422 when course is full", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 1 }),
                studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }),
                studentWasRegistered({ studentId: "s2", name: "Bob", studentNumber: 2 }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
            .when(agent => agent.post("/subscribe-student-to-course").send({ courseId: "c1", studentId: "s2" }))
            .then(expectError(422))
    })

    test("returns 422 when student already subscribed", async () => {
        await spec
            .existingEvents(
                courseWasRegistered({ courseId: "c1", title: "Math", capacity: 30 }),
                studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }),
                studentWasSubscribed({ courseId: "c1", studentId: "s1" })
            )
            .when(agent => agent.post("/subscribe-student-to-course").send({ courseId: "c1", studentId: "s1" }))
            .then(expectError(422))
    })

    test("returns 400 when studentId is missing", async () => {
        await spec
            .when(agent => agent.post("/subscribe-student-to-course").send({ courseId: "c1" }))
            .then(expectError(400))
    })
})
