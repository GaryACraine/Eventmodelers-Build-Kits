import { configDefaults, defineConfig } from "vitest/config"
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
        exclude: [...configDefaults.exclude, "web/**"], // the frontend has its own tests (cd web && npm test)
        testTimeout: 60000,
        globalSetup: "./src/test/vitest.globalSetup.ts",
        pool: "forks",
        poolOptions: { forks: { singleFork: true } }
    }
})
