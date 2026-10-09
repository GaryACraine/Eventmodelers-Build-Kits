import nodemailer from "nodemailer"
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"
import type { AuthConfig } from "./config.js"

/** One email from the sign-in service: a verification link, and later a reset link or a code (ADR-056) */
export interface Email {
    to: string
    subject: string
    text: string
}

export type SendEmail = (email: Email) => Promise<void>

/**
 * Sending email, by deployment (ADR-055): SES in our cloud, with the task's IAM role (nodemailer's SES transport over
 * the SESv2 client, so no SMTP password to keep), or any SMTP server on-premises (Mailpit locally).
 */
export function emailSender(config: AuthConfig): SendEmail {
    const { transport, from } = config.email
    const mailer =
        transport.kind === "ses"
            ? nodemailer.createTransport({ SES: { sesClient: new SESv2Client({ region: transport.region }), SendEmailCommand } })
            : nodemailer.createTransport(transport.url)
    return async ({ to, subject, text }) => {
        await mailer.sendMail({ from, to, subject, text })
    }
}
