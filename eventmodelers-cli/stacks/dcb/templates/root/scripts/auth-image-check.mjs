#!/usr/bin/env node
// The sign-in service's image holds only what runs (ADR-063): it builds `auth/` as a release would, then looks inside.
// Needs Docker. Record it as evidence:
//
//   npm run security:record -- auth-image -- node scripts/auth-image-check.mjs
//
// It prints one line per check ("ok: …" or "FAILED: …") and exits 1 when any fails.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const auth = fileURLToPath(new URL("../auth/", import.meta.url))
const tag = `auth-image-check:${process.pid}`
const TOOLING = ["vitest", "@vitest", "vite", "tinypool", "testcontainers", "@testcontainers", "typescript"]

const inside = script => execFileSync("docker", ["run", "--rm", "--entrypoint", "sh", tag, "-c", script], { encoding: "utf8" }).trim()
let failed = 0
const check = (ok, line) => {
    console.log(`${ok ? "ok" : "FAILED"}: ${line}`)
    if (!ok) failed++
}

console.log(`building ${auth} as ${tag}`)
execFileSync("docker", ["build", "-q", "-t", tag, auth], { stdio: ["ignore", "ignore", "inherit"] })
try {
    const installed = inside("ls node_modules; ls -d node_modules/@*/* 2>/dev/null | sed 's|node_modules/||'").split("\n")
    const found = TOOLING.filter(name => installed.includes(name))
    check(found.length === 0, `the sign-in image holds no test tooling${found.length ? ` (found ${found.join(", ")})` : ""}`)
    check(inside("node -e \"import('better-auth').then(() => console.log('loaded'))\"") === "loaded", "better-auth loads in the sign-in image")
    check(inside("id -un") === "node", "the sign-in image runs as the node user, not root")
    console.log(`entries in the image's node_modules: ${installed.length}`)
} finally {
    execFileSync("docker", ["image", "rm", "-f", tag], { stdio: "ignore" })
}
process.exit(failed ? 1 : 0)
