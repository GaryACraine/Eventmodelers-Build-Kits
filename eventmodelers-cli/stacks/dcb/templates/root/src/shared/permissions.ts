import { existsSync, readFileSync } from "node:fs"

/**
 * Who may do what (ADR-058, ADR-060): the model's role map, which emcli writes to `api/roles.json` at export, and the
 * one decision every permission route makes with it. The roles a caller holds come from the project's own read
 * models (a `RoleLookup`, wired in `index.ts`); the token says only who is calling.
 *
 * A role is **platform**-scoped (the platform admin: it holds its permissions everywhere) or **organisation**-scoped
 * (an owner, an admin: only in the organisation it was given in). An organisation-scoped permission is checked in the
 * organisation the request names, by the tenant key (`organisationId`) in its path or body.
 *
 * **How strongly the caller must have signed in** (ADR-056 D1, D3): each role has a sign-in level, `second-factor`
 * by default. The token's `amr` says which factors this session proved; a role's permission counts only when they're
 * enough for its level. Otherwise the caller is asked to step up.
 */
export interface RoleMap {
    /** The field that names the organisation in a request, e.g. "organisationId" */
    tenantKey: string
    roles: Record<string, { scope: "organisation" | "platform"; permissions: string[]; signIn?: SignInLevel }>
}

/**
 * How strongly a session signed in (ADR-056 D3), from the factors in its token (`amr`, set by the sign-in service):
 * - **second-factor:** anything beyond the password: an emailed code, the app, a backup code, a passkey, a device
 *   trusted after one of those, the link that verified a new account, or `mfa` (one of the app, a backup code or a
 *   passkey, proved over 12 hours ago, D15);
 * - **not-by-email:** the app, a backup code or a passkey, proved in the last 12 hours (the sign-in service drops
 *   them from the token after that, D15). Taking the inbox alone never reaches it.
 */
export type SignInLevel = "second-factor" | "not-by-email"

const SECOND_FACTORS = ["email-otp", "totp", "backup-code", "passkey", "trusted-device", "email-link", "mfa"]
const NOT_BY_EMAIL = ["totp", "backup-code", "passkey"]

/** Whether a session with these factors has signed in strongly enough for `level` */
export function meets(factors: readonly string[], level: SignInLevel): boolean {
    return factors.some(f => (level === "not-by-email" ? NOT_BY_EMAIL : SECOND_FACTORS).includes(f))
}

/** What a permission check decided: go ahead, refuse, hide the organisation, or ask for a stronger sign-in */
export type Decision = "allow" | "forbidden" | "not-found" | { stepUp: SignInLevel }

/** The roles a caller holds: platform-wide, and in the organisation the request names (none when it names none) */
export interface CallerRoles {
    platform: string[]
    organisation: string[]
}

/**
 * The caller's roles, from the project's read models: `sub` and `email` from the token, `session` from the lookup,
 * and the organisation the request names (the tenant key), if any. Only that organisation's roles are needed.
 */
export type RoleLookup = (
    caller: { sub: string; email: string; session: Record<string, string> },
    organisation?: string
) => Promise<CallerRoles>

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

const levelOf = (map: RoleMap, role: string): SignInLevel => map.roles[role]?.signIn ?? "second-factor"

/**
 * May this caller use `permission`, in the organisation `tenant` names (if any), having signed in with `factors`?
 * - **allow:** a role that holds it (platform-wide, or in that organisation) has its sign-in level met;
 * - **step-up:** roles hold it, but none has its level met: the weakest level among them is asked for;
 * - **not-found:** the caller holds no role in that organisation (it doesn't say whether the organisation exists);
 * - **forbidden:** otherwise (a member without the permission, or a request that names no organisation).
 */
export function decide(map: RoleMap, caller: CallerRoles, permission: string, factors: readonly string[], tenant?: string): Decision {
    const granting = caller.platform.filter(role => holds(map, role, "platform", permission))
    if (tenant) granting.push(...caller.organisation.filter(role => holds(map, role, "organisation", permission)))
    if (granting.some(role => meets(factors, levelOf(map, role)))) return "allow"
    if (granting.length > 0)
        return { stepUp: granting.some(role => levelOf(map, role) === "second-factor") ? "second-factor" : "not-by-email" }
    if (!tenant) return "forbidden"
    return caller.organisation.length === 0 ? "not-found" : "forbidden"
}

/**
 * The permissions this caller holds (ADR-065 step 3): platform roles' everywhere, and organisation roles' in the
 * organisation `tenant` names. The same roles `decide` grants with, whatever the sign-in level: a permission held only
 * at a stronger level is still listed, since using it asks the person to step up. The web app shows what's listed
 * (its menu, a page's actions); the API still decides every request.
 */
export function held(map: RoleMap, caller: CallerRoles, tenant?: string): string[] {
    const roles = [
        ...caller.platform.filter(role => map.roles[role]?.scope === "platform"),
        ...(tenant ? caller.organisation.filter(role => map.roles[role]?.scope === "organisation") : [])
    ]
    return [...new Set(roles.flatMap(role => map.roles[role].permissions))].sort()
}
