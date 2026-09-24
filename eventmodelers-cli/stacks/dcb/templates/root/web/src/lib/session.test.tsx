import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { RequireSession, SessionProvider, useSession, useSessionState } from "./session"
import { WritesProvider, useWrites } from "./writes"

function Greeting() {
    return <p>Hello {useSession().studentId}</p>
}

function SignOut() {
    return <button onClick={useSessionState().signOut}>Sign out</button>
}

describe("the session (a stub until real sign-in)", () => {
    it("asks for the missing keys, then shows the page; signing out asks again", async () => {
        render(
            <SessionProvider remember={false}>
                <SignOut />
                <RequireSession keys={["studentId"]}>
                    <Greeting />
                </RequireSession>
            </SessionProvider>
        )
        await userEvent.type(screen.getByLabelText("Student ID"), "s1")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(screen.getByText("Hello s1")).toBeInTheDocument()

        await userEvent.click(screen.getByRole("button", { name: "Sign out" }))
        expect(screen.getByRole("form", { name: "Sign in" })).toBeInTheDocument()
    })

    it("starts signed in with `initial`, and remembers a sign-in in this browser", async () => {
        render(
            <SessionProvider initial={{ studentId: "s2" }}>
                <RequireSession keys={["studentId"]}>
                    <Greeting />
                </RequireSession>
            </SessionProvider>
        )
        expect(screen.getByText("Hello s2")).toBeInTheDocument()
        localStorage.clear()

        const { unmount } = render(
            <SessionProvider>
                <RequireSession keys={["studentId"]}>
                    <Greeting />
                </RequireSession>
            </SessionProvider>
        )
        await userEvent.type(screen.getByLabelText("Student ID"), "s3")
        await userEvent.click(screen.getByRole("button", { name: "Continue" }))
        unmount()
        expect(JSON.parse(localStorage.getItem("session")!)).toEqual({ studentId: "s3" })
        localStorage.clear()
    })
})

describe("read-your-writes", () => {
    it("recordWrite remembers the position and refetches; afterLastWrite asks an async read model to wait for it", async () => {
        const fetched: Record<string, string>[] = []
        let record: ((position: string | undefined) => Promise<void>) | undefined
        function View() {
            const { recordWrite, afterLastWrite } = useWrites()
            record = recordWrite
            const { data } = useQuery({ queryKey: ["view"], queryFn: () => (fetched.push(afterLastWrite()), Promise.resolve(fetched.length)) })
            return <p>fetched {data}</p>
        }
        render(
            <QueryClientProvider client={new QueryClient()}>
                <WritesProvider>
                    <View />
                </WritesProvider>
            </QueryClientProvider>
        )
        expect(await screen.findByText("fetched 1")).toBeInTheDocument()
        await record!("42")
        expect(fetched).toEqual([{}, { "If-None-Match": '"42"', Prefer: "wait=5" }])
        await record!(undefined) // a command without an ETag keeps the last position
        expect(fetched.at(-1)).toEqual({ "If-None-Match": '"42"', Prefer: "wait=5" })
    })
})
