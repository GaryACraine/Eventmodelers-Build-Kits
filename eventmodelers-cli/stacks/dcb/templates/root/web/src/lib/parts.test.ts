import { navigation } from "./navigation"
import { built, missingParts, slices, type SliceParts } from "./parts"

// The model and the slices agree (ADR-069): every part navigation.json puts on a page is exported by its slice.

describe("the parts the model names", () => {
    it("are each exported by their slice's index.ts", () => {
        expect(navigation ? missingParts(navigation, slices, built) : []).toEqual([])
    })

    it("are found missing: a built slice with no index.ts, or one that doesn't export the part; one not built yet waits", () => {
        const from: SliceParts = { invitemember: { InviteMember: () => null } }
        const named = {
            tenantKey: "organisationId", entities: {}, menu: [], account: [],
            pages: {
                "/organisations/:organisationId": {
                    title: "Dashboard", context: "licensing", tenant: true, reads: [], actions: [],
                    parts: [
                        { slice: "invitemember", component: "InviteMemberForm", kind: "form" as const, props: {} },
                        { slice: "organisationinvitations", component: "OrganisationInvitationsView", kind: "view" as const, props: {},
                          row: [{ slice: "invitemember", component: "InviteMember", kind: "form" as const, props: {} }] }
                    ]
                }
            }
        }
        expect(missingParts(named, from, new Set())).toEqual([])
        expect(missingParts(named, from, new Set(["invitemember", "organisationinvitations"]))).toEqual([
            "/organisations/:organisationId: src/slices/invitemember/index.ts exports no InviteMemberForm",
            "/organisations/:organisationId: src/slices/organisationinvitations/index.ts is missing (it should export OrganisationInvitationsView)"
        ])
    })
})
