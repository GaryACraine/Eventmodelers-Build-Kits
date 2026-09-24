const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:3000"

async function post(path: string, body: unknown, expectedStatus = 201): Promise<void> {
    const url = `${BASE_URL}${path}`
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    })
    const etag = res.headers.get("etag") ?? ""
    console.log(`POST ${path} → ${res.status}${etag ? ` ETag: ${etag}` : ""}`)
    if (res.status !== expectedStatus) {
        const text = await res.text()
        console.error(`Unexpected status ${res.status} for POST ${path}: ${text}`)
        process.exit(1)
    }
}

await post("/register-course", { id: "ts101", title: "Introduction to TypeScript", capacity: 2 })
await post("/register-course", { id: "go101", title: "Introduction to Go", capacity: 20 })
await post("/register-course", { id: "extra101", title: "Bonus Course", capacity: 5 })

await post("/register-student", { id: "alice", name: "Alice" })
await post("/register-student", { id: "bob", name: "Bob" })
await post("/register-student", { id: "charlie", name: "Charlie" })

await post("/subscribe-student-to-course", { courseId: "ts101", studentId: "alice" })
await post("/subscribe-student-to-course", { courseId: "ts101", studentId: "bob" })
await post("/subscribe-student-to-course", { courseId: "go101", studentId: "charlie" })

console.log("Seed complete.")
