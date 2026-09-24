import { render, screen } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { App } from "./App"
import { afterWrite, api, apiUrl, command, positionOf, read, ApiError } from "./lib/api"
import { server } from "./mocks/server"

describe("the app shell", () => {
    it("finds the pages in src/pages/: the start page, linked from the header", async () => {
        render(<App initialPath="/" />)
        expect(await screen.findByRole("navigation")).toHaveTextContent("Home")
        // "Pages" lists the built pages; an app with none yet says so
        expect(screen.getByRole("heading", { name: /^(Pages|Nothing here yet)$/ })).toBeInTheDocument()
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
