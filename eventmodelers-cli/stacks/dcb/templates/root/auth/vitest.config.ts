import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        include: ["src/**/*.tests.ts"],
        testTimeout: 60000,
        hookTimeout: 120000
    }
})
