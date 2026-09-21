import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
    resolve: {
        alias: {
            "@test": path.resolve(__dirname, "./src/test")
        }
    },
    test: {
        globals: true,
        include: ["**/*.tests.ts"],
        testTimeout: 60000,
        globalSetup: "./src/test/vitest.globalSetup.ts",
        pool: "forks",
        poolOptions: { forks: { singleFork: true } }
    }
})
