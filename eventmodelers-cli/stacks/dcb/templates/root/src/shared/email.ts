import nodemailer, { type Transporter } from "nodemailer"
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js"
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"

/**
 * Email from the API (ADR-068): an automation's work sends it, as it calls any other system (ADR-039), and records
 * that it did. The same setup as the sign-in service's (`auth/src/email.ts`, ADR-055): SES in our cloud, with the
 * task's IAM role, or any SMTP server on-premises. Locally that's Mailpit (docker-compose: http://localhost:8025),
 * which keeps every email instead of delivering it.
 *
 *   variable            default                      what
 *   EMAIL_FROM          no-reply@localhost           the sender
 *   EMAIL_TRANSPORT     smtp                         smtp | ses
 *   SMTP_URL            smtp://localhost:1025        Mailpit locally
 *   AWS_REGION          (required for ses)
 *   EMAIL_TIMEOUT_MS    10000                        our deadline per email, below the activity's startToCloseTimeout
 *   APP_URL             http://localhost:5173        the web app, for links in an email
 */
export interface Email {
    to: string
    subject: string
    text: string
}

export type SendEmail = (email: Email) => Promise<void>

export interface EmailConfig {
    from: string
    transport: { kind: "smtp"; url: string } | { kind: "ses"; region: string }
    timeoutMs: number
    /** The web app's address, for links (`${appUrl}/invitations/…`) */
    appUrl: string
}

export function emailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
    const kind = env["EMAIL_TRANSPORT"] ?? "smtp"
    if (kind !== "smtp" && kind !== "ses") throw new Error(`EMAIL_TRANSPORT is smtp or ses, not "${kind}"`)
    const timeoutMs = Number(env["EMAIL_TIMEOUT_MS"] ?? 10000)
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("EMAIL_TIMEOUT_MS must be a positive whole number")
    let transport: EmailConfig["transport"]
    if (kind === "ses") {
        const region = env["AWS_REGION"]
        if (!region) throw new Error("AWS_REGION: required to send email through SES")
        transport = { kind, region }
    } else {
        transport = { kind, url: env["SMTP_URL"] ?? "smtp://localhost:1025" }
    }
    return {
        from: env["EMAIL_FROM"] ?? "no-reply@localhost",
        transport,
        timeoutMs,
        appUrl: (env["APP_URL"] ?? "http://localhost:5173").replace(/\/+$/, "")
    }
}

/** A sender for the config. `transporter` is for tests (nodemailer's `jsonTransport`). */
export function emailSender(config: EmailConfig, transporter?: Transporter): SendEmail {
    const { transport, from, timeoutMs } = config
    const mailer =
        transporter ??
        (transport.kind === "ses"
            ? nodemailer.createTransport({ SES: { sesClient: new SESv2Client({ region: transport.region }), SendEmailCommand } })
            : nodemailer.createTransport({
                  url: transport.url,
                  connectionTimeout: timeoutMs,
                  greetingTimeout: timeoutMs,
                  socketTimeout: timeoutMs
              } satisfies SMTPTransport.Options))
    return async ({ to, subject, text }) => {
        let timer: NodeJS.Timeout | undefined
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Sending email took longer than ${timeoutMs} ms`)), timeoutMs)
        })
        try {
            await Promise.race([mailer.sendMail({ from, to, subject, text }), deadline])
        } finally {
            clearTimeout(timer)
        }
    }
}
