/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** The backend's origin, e.g. http://localhost:3000. Empty: this page's own origin. */
    readonly VITE_API_BASE?: string
    /** `mock` serves every API request from src/mocks/handlers.ts; anything else calls the backend. */
    readonly VITE_DATA_MODE?: "mock" | "live"
    /** `better-auth`: real sign-in, through the sign-in service at /api/auth (ADR-055). Anything else: the stub. */
    readonly VITE_SIGN_IN?: "stub" | "better-auth"
    /** Rows per page of a list (Load more, ADR-026). Default 20. */
    readonly VITE_PAGE_SIZE?: string
}
