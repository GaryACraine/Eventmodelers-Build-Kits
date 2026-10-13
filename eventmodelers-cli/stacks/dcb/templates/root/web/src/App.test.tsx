import { render, screen } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { App } from "./App"
import { afterWrite, api, apiUrl, command, positionOf, read, retryRead, ApiError, STILL_UPDATING } from "./lib/api"
import { server } from "./mocks/server"

describe("the app shell", () => {
    it("renders the header around the pages", async () => {
        render(<App initialPath="/" />)
        // The menu is the model's once an export writes src/navigation.json (ADR-065), so the shell is checked here,
        // not the menu's items or the start page (lib/navigation.test.tsx covers the menu)
        expect(await screen.findByRole("navigation")).toHaveTextContent("App")
    })

    it("shows who is signed in", async () => {
        render(<App initialPath="/" session={{ studentId: "s1" }} />)
        expect(await screen.findByRole("navigation")).toHaveTextContent("studentId s1")
    })
})

// The untyped client: the placeholder api-types.ts has no paths until `npm run gen:api`.
const untyped = api as unknown as {
    POST: (path: string, init?: object) => Promise<{ data?: unknown; error?: unknown; response: Response }>
    GET: (path: string, init?: object) => Promise<{ data?: unknown; error?: unknown; response: Response }>
}

describe("the API client (answered by MSW)", () => {
    it("a command returns the position its ETag carries, and sends an Idempotency-Key", async () => {
        let key: string | null = null
        server.use(
            http.post(apiUrl("/things"), ({ request }) => {
                key = request.headers.get("Idempotency-Key")
                return HttpResponse.json({ id: "t1" }, { status: 201, headers: { ETag: '"42"' } })
            })
        )
        const result = await command(untyped.POST("/things", { body: { name: "x" } }))
        expect(result).toEqual({ data: { id: "t1" }, position: "42" })
        expect(key).toMatch(/^[0-9a-f-]{36}$/)
    })

    it("a read still catching up with the last write (504) says so, and is tried again until it has", async () => {
        server.use(http.get(apiUrl("/things/t1"), () => HttpResponse.json({ title: "Gateway Timeout", status: 504 }, { status: 504 })))
        const error = (await read(untyped.GET("/things/t1", { headers: afterWrite("42") })).catch((e: unknown) => e)) as ApiError
        expect(error).toMatchObject({ status: 504, stillUpdating: true, message: STILL_UPDATING })
        expect([0, 1, 2, 3, 4].map((failures) => retryRead(failures, error))).toEqual([true, true, true, true, true])
        expect(retryRead(5, error)).toBe(false)
    })

    it("tries any other 5xx or a network error once, and a refusal never", () => {
        const failed = new ApiError(500, { title: "Internal Server Error" })
        expect([retryRead(0, failed), retryRead(1, failed)]).toEqual([true, false])
        expect(retryRead(0, new TypeError("Failed to fetch"))).toBe(true)
        expect(retryRead(0, new ApiError(404, { detail: "Course not found" }))).toBe(false)
        expect(failed.stillUpdating).toBe(false)
    })

    it("a rejection throws ApiError with the Problem-JSON's detail", async () => {
        server.use(
            http.post(apiUrl("/things"), () =>
                HttpResponse.json({ title: "Conflict", status: 409, detail: "Course is full" }, { status: 409 })
            )
        )
        const error = await command(untyped.POST("/things", { body: {} })).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ApiError)
        expect(error).toMatchObject({ status: 409, message: "Course is full" })
    })

    it("afterWrite asks an async read model to wait for the position; without one it sends nothing", async () => {
        let headers: Headers | undefined
        server.use(
            http.get(apiUrl("/things/t1"), ({ request }) => {
                headers = request.headers
                return HttpResponse.json({ id: "t1" })
            })
        )
        expect(await read(untyped.GET("/things/t1", { headers: afterWrite("42") }))).toEqual({ id: "t1" })
        expect(headers?.get("If-None-Match")).toBe('"42"')
        expect(headers?.get("Prefer")).toBe("wait=5")
        expect(afterWrite(undefined)).toEqual({})
        expect(positionOf(new Response(null, { headers: { ETag: 'W/"7"' } }))).toBe("7")
    })
})
