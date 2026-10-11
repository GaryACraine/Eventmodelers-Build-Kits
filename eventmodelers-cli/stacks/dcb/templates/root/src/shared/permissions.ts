import { existsSync, readFileSync } from "node:fs"

/**
 * Who may do what (ADR-058, ADR-060): the model's role map, which emcli writes to `api/roles.json` at export, and the
 * one decision every permission route makes with it. The roles a caller holds come from the project's own read
 * models (a `RoleLookup`, wired in `index.ts`); the token says only who is calling.
 *
 * A role is **platform**-scoped (the platform admin: it holds its permissions everywhere) or **organisation**-scoped
 * (an owner, an admin: only in the organisation it was given in). An organisation-scoped permission is checked in the
 * organisation the request names, by the tenant key (`organisationId`) in its path or body.
 */
export interface RoleMap {
    /** The field that names the organisation in a request, e.g. "organisationId" */
    tenantKey: string
    roles: Record<string, { scope: "organisation" | "platform"; permissions: string[] }>
}

/** The roles a caller holds: platform-wide, and per organisation (keyed by the organisation's id) */
export interface CallerRoles {
    platform: string[]
    organisations: Record<string, string[]>
}

/** The caller's roles, from the project's read models: `sub` and `email` from the token, `session` from the lookup */
export type RoleLookup = (caller: { sub: string; email: string; session: Record<string, string> }) => Promise<CallerRoles>

let loaded: { file: string; map: RoleMap | undefined } | undefined

/** The role map in `ROLES_FILE` (default `api/roles.json`, from the working directory); undefined when there's none */
export function roleMap(file = process.env["ROLES_FILE"] ?? "api/roles.json"): RoleMap | undefined {
    if (loaded?.file === file) return loaded.map
    const map = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RoleMap) : undefined
    loaded = { file, map }
    return map
}

const holds = (map: RoleMap, role: string, scope: "organisation" | "platform", permission: string) =>
    map.roles[role]?.scope === scope && map.roles[role].permissions.includes(permission)

/**
 * May this caller use `permission`, in the organisation `tenant` names (if any)?
 * - **allow:** a platform role holds it, or a role the caller holds in that organisation does;
 * - **not-found:** the caller holds no role in that organisation (it doesn't say whether the organisation exists);
 * - **forbidden:** otherwise (a member without the permission, or a request that names no organisation).
 */
export function decide(map: RoleMap, caller: CallerRoles, permission: string, tenant?: string): "allow" | "forbidden" | "not-found" {
    if (caller.platform.some(role => holds(map, role, "platform", permission))) return "allow"
    if (!tenant) return "forbidden"
    const roles = caller.organisations[tenant] ?? []
    if (roles.length === 0) return "not-found"
    return roles.some(role => holds(map, role, "organisation", permission)) ? "allow" : "forbidden"
}
