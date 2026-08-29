import nodemailer from "nodemailer"
import type { Transporter } from "nodemailer"

import { env } from "../config/env"
import { logger } from "../shared/logger"

const log = logger.child({ component: "mailer" })

let transporter: Transporter | undefined

function getTransporter(): Transporter | undefined {
	if (!env.smtp) return undefined
	if (!transporter) {
		transporter = nodemailer.createTransport({
			host: env.smtp.host,
			port: env.smtp.port,
			secure: false,
			requireTLS: true,
			auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
		})
	}
	return transporter
}

export interface Mail {
	to: string
	subject: string
	html: string
	text?: string
}

/**
 * With no SMTP host configured the mail is logged instead of sent, so local
 * development works without credentials. A send failure never propagates: an
 * invitation email that bounces must not roll back the invitation itself.
 */
export async function sendMail(mail: Mail): Promise<void> {
	const client = getTransporter()
	if (!client || !env.smtp) {
		log.info("SMTP not configured, mail not sent", { to: mail.to, subject: mail.subject })
		return
	}

	try {
		await client.sendMail({
			from: env.smtp.from,
			to: mail.to,
			subject: mail.subject,
			html: mail.html,
			text: mail.text,
		})
		log.info("Mail sent", { to: mail.to, subject: mail.subject })
	} catch (error) {
		log.error("Mail delivery failed", error, { to: mail.to, subject: mail.subject })
	}
}
