import type { Server } from "node:http"
import { Test } from "supertest"

/**
 * supertest's own server listens on 127.0.0.1, where its requests go. supertest 7 starts an app on any free port at
 * every address (`::`) and sends to 127.0.0.1, and macOS will give that port to it even when another program holds it
 * on 127.0.0.1 alone. The request then reaches the other program: an IDE's built-in web server (IntelliJ's, on 63342)
 * answered 301 to a licensing test, about one full run in four. Bound to 127.0.0.1, the port is free there.
 *
 * supertest reads its server's address as soon as it starts it, before a listen on a named address has finished, so
 * the request's URL is set when the server is listening, just before it's sent. A server the test started itself keeps
 * its address. Loaded before every test file (`setupFiles` in vitest.config.ts).
 */
type Done = (error: unknown, response: unknown) => void
interface Request {
    url: string
    serverAddress(app: Server, path: string): string
    end(fn?: Done): Request
    loopback?: { server: Server; path: string }
}
const prototype = Test.prototype as unknown as Request
const { serverAddress, end } = prototype

prototype.serverAddress = function (this: Request, app: Server, path: string) {
    if (app.address() || app.listening) return serverAddress.call(this, app, path)
    app.listen(0, "127.0.0.1")
    this.loopback = { server: app, path }
    return `http://127.0.0.1${path}`
}

prototype.end = function (this: Request, fn?: Done) {
    const loopback = this.loopback
    if (!loopback) return end.call(this, fn)
    const { server, path } = loopback
    const send = () => {
        server.removeListener("error", failed)
        this.url = `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`
        end.call(this, (error, response) => {
            server.close()
            fn?.(error, response)
        })
    }
    const failed = (error: unknown) => {
        server.removeListener("listening", send)
        fn?.(error, undefined)
    }
    if (server.address()) send()
    else {
        server.once("listening", send)
        server.once("error", failed)
    }
    return this
}
