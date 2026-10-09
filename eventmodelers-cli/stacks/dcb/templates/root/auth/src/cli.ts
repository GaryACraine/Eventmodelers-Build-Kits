import { createAuth } from "./auth.js"
import { loadConfig } from "./config.js"

/**
 * Only for Better Auth's CLI, which reads `auth` from this file to write the tables' SQL (`npm run schema`, against an
 * empty database; better-auth.com/docs/concepts/cli). The SQL is then committed as a migration in `migrations/`.
 */
export const auth = createAuth(
    loadConfig({
        DEPLOYMENT: "on-premises",
        BETTER_AUTH_URL: "http://localhost:5173",
        BETTER_AUTH_SECRET: "schema-generation-only-schema-generation-only",
        DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://dcb:dcb@localhost:5432/dcb",
        EMAIL_FROM: "unused@localhost",
        SMTP_URL: "smtp://localhost:1025"
    }),
    async () => {}
)
