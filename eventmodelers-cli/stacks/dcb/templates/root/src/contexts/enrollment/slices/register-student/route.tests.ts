import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configureRegisterStudentRoute } from "./route.js"
import { studentWasRegistered } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configureRegisterStudentRoute({ store, pool: {} as Pool })
})

describe("POST /register-student — register student", () => {
    test("registers a new student and returns 204", async () => {
        await spec
            .when(agent => agent.post("/register-student").send({ id: "s1", name: "Alice" }))
            .then(
                expectResponse(204),
                studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 })
            )
    })

    test("returns 422 when student already exists", async () => {
        await spec
            .existingEvents(studentWasRegistered({ studentId: "s1", name: "Alice", studentNumber: 1 }))
            .when(agent => agent.post("/register-student").send({ id: "s1", name: "Alice" }))
            .then(expectError(422))
    })

    test("returns 400 when name is missing", async () => {
        await spec.when(agent => agent.post("/register-student").send({ id: "s1" })).then(expectError(400))
    })
})
