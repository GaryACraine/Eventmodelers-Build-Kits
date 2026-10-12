import { describe, it, expect } from "vitest"
import nodemailer, { type Transporter } from "nodemailer"
import { emailConfig, emailSender } from "./email.js"

describe("emailConfig", () => {
    it("defaults to Mailpit and the local web app", () => {
        expect(emailConfig({})).toEqual({
            from: "no-reply@localhost",
            transport: { kind: "smtp", url: "smtp://localhost:1025" },
            timeoutMs: 10000,
            appUrl: "http://localhost:5173"
        })
    })

    it("takes SES with a region, and trims the app's address", () => {
        expect(emailConfig({ EMAIL_TRANSPORT: "ses", AWS_REGION: "eu-west-2", EMAIL_FROM: "team@example.com", APP_URL: "https://app.example.com/" }))
            .toMatchObject({ from: "team@example.com", transport: { kind: "ses", region: "eu-west-2" }, appUrl: "https://app.example.com" })
    })

    it("refuses an incomplete or unknown setting", () => {
        expect(() => emailConfig({ EMAIL_TRANSPORT: "ses" })).toThrow("AWS_REGION")
        expect(() => emailConfig({ EMAIL_TRANSPORT: "pigeon" })).toThrow("smtp or ses")
        expect(() => emailConfig({ EMAIL_TIMEOUT_MS: "soon" })).toThrow("EMAIL_TIMEOUT_MS")
    })
})

describe("emailSender", () => {
    it("sends from the configured sender", async () => {
        const sent: unknown[] = []
        const json = nodemailer.createTransport({ jsonTransport: true })
        const spy = { sendMail: async (m: object) => { sent.push(m); return json.sendMail(m) } } as unknown as Transporter
        await emailSender(emailConfig({ EMAIL_FROM: "team@example.com" }), spy)({ to: "ada@example.com", subject: "Hi", text: "Hello" })
        expect(sent).toEqual([{ from: "team@example.com", to: "ada@example.com", subject: "Hi", text: "Hello" }])
    })

    it("gives up at our deadline", async () => {
        const never = { sendMail: () => new Promise(() => {}) } as unknown as Transporter
        const send = emailSender(emailConfig({ EMAIL_TIMEOUT_MS: "20" }), never)
        await expect(send({ to: "ada@example.com", subject: "Hi", text: "Hello" })).rejects.toThrow("longer than 20 ms")
    })
})
