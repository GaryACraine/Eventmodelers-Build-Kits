/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: { "@": path.resolve(import.meta.dirname, "src") }
    },
    // Sign-in is served at this page's own origin, so its session cookie is first-party (ADR-055; Better Auth's cookie
    // docs): /api/auth goes to the sign-in service (Compose's `auth`). Deployed, a reverse proxy or CloudFront does this.
    // xfwd sends the browser's address on, for the service's rate limits.
    server: {
        proxy: { "/api/auth": { target: process.env.AUTH_URL ?? "http://localhost:3001", xfwd: true } }
    },
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./src/test/setup.ts"],
        include: ["src/**/*.test.{ts,tsx}"]
    }
})
