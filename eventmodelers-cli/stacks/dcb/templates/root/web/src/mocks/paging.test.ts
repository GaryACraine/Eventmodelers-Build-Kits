import { page } from "./paging"

describe("mock paging (like the backend's)", () => {
    const rows = [1, 2, 3, 4, 5]
    const at = (query: string) => page(rows, new Request(`http://api.test/list${query}`))

    it("gives a page, and a cursor only while there are more", () => {
        expect(at("?limit=2")).toEqual({ data: [1, 2], cursor: "2" })
        expect(at("?limit=2&cursor=2")).toEqual({ data: [3, 4], cursor: "4" })
        expect(at("?limit=2&cursor=4")).toEqual({ data: [5] })
        expect(at("")).toEqual({ data: rows })
    })
})
