import { act, renderHook } from "@testing-library/react"
import { ApiError } from "./api"
import { useSubmitOnce } from "./submit"

describe("useSubmitOnce", () => {
    it("sends once while a send is in flight, and is pending until it ends", async () => {
        const { result } = renderHook(() => useSubmitOnce())
        let finish!: (v: string) => void
        const send = vi.fn(() => new Promise<string>(resolve => (finish = resolve)))
        let first!: Promise<string | undefined>
        let second!: Promise<string | undefined>
        act(() => {
            first = result.current.run(send)
            second = result.current.run(send)
        })
        expect(await second).toBeUndefined()
        expect(result.current.pending).toBe(true)
        await act(async () => finish("done"))
        expect(await first).toBe("done")
        expect(send).toHaveBeenCalledTimes(1)
        expect(result.current.pending).toBe(false)
    })

    it("keeps the key when the network failed: the next press is the same intent", async () => {
        const { result } = renderHook(() => useSubmitOnce())
        const keys: string[] = []
        await act(async () => {
            await result.current.run(async k => { keys.push(k); throw new TypeError("Failed to fetch") }).catch(() => {})
            await result.current.run(async k => { keys.push(k) })
        })
        expect(keys[0]).toBe(keys[1])
    })

    it("takes a new key once the server answered, done or refused", async () => {
        const { result } = renderHook(() => useSubmitOnce())
        const keys: string[] = []
        await act(async () => {
            await result.current.run(async k => { keys.push(k); throw new ApiError(422, { status: 422, title: "Refused", detail: "No" }) }).catch(() => {})
            await result.current.run(async k => { keys.push(k) })
            await result.current.run(async k => { keys.push(k) })
        })
        expect(new Set(keys).size).toBe(3)
    })
})
