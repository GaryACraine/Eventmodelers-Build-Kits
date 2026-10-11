import { describe, test, expect, vi } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import express from "express"
import supertest from "supertest"

/** An app that says which local address the request arrived on */
const app = () => {
    const app = express()
    app.post("/activate-organisation", (req, res) => void res.status(422).json({ ours: true, host: req.socket.localAddress }))
    return app
}

describe("supertest's server listens on 127.0.0.1 (src/test/loopback.ts)", () => {
    test("the request reaches the app on 127.0.0.1, and its server is closed afterwards", async () => {
        const started: { server: http.Server; args: unknown[] }[] = []
        const original = http.Server.prototype.listen
        const listen = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server, ...args: unknown[]) {
            started.push({ server: this, args })
            return (original as (...a: unknown[]) => http.Server).apply(this, args)
        })
        const res = await supertest(app()).post("/activate-organisation")
        listen.mockRestore()
        expect(res.status).toBe(422)
        expect(res.body).toEqual({ ours: true, host: "127.0.0.1" })
        expect(started.map(({ args }) => args)).toEqual([[0, "127.0.0.1"]])
        expect(started[0].server.listening).toBe(false)
    })

    test("each request gets its own server; expect() and end() still work", async () => {
        const request = supertest(app())
        await request.post("/activate-organisation").expect(422)
        await request.post("/activate-organisation").expect(422, { ours: true, host: "127.0.0.1" })
        const status = await new Promise<number>((resolve, reject) =>
            request.post("/activate-organisation").end((error, res) => (error ? reject(error) : resolve(res.status)))
        )
        expect(status).toBe(422)
    })

    test("a server the test started keeps its own address", async () => {
        const server = http.createServer(app())
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
        const res = await supertest(server).post("/activate-organisation")
        expect(res.status).toBe(422)
        expect((server.address() as AddressInfo).address).toBe("127.0.0.1")
        server.close()
    })
})
