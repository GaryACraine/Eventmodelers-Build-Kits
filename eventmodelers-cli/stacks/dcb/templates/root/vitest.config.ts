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
        exclude: [...configDefaults.exclude, "web/**", "auth/**"], // the frontend and sign-in have their own tests (cd web && npm test; cd auth && npm test)
        testTimeout: 60000,
        globalSetup: "./src/test/vitest.globalSetup.ts",
        setupFiles: ["./src/test/loopback.ts"], // a test's server listens on 127.0.0.1, so no other program can answer it
        pool: "forks",
        poolOptions: { forks: { singleFork: true } }
    }
})
