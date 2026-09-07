import { z } from "zod"

import { env } from "../../../config/env"
import { sendMail } from "../../../mail/mailer"
import { isAppError } from "../../../shared/errors"
import { logger } from "../../../shared/logger"
import { markUsed, requireIntegration } from "./integrations"
import type { AgentTool, ToolContext, ToolResult } from "./types"

const log = logger.child({ module: "agent.email" })

const parameters = z.object({
	to: z.string().trim().email().describe("Recipient. Must be on the connection's allowlist."),
	subject: z.string().trim().min(1).max(200),
	body: z.string().trim().min(1).max(20_000).describe("Plain text. Markdown is not rendered."),
})

/**
 * Send an email.
 *
 * The recipient allowlist is the whole safety story, and it is deliberately
 * strict: an `email` integration with an empty allowlist refuses everything.
 * Defaulting an unconfigured allowlist to "anyone" would mean the first person
 * to create the integration accidentally gives every agent in the deployment a
 * way to mail the world — and an agent's instructions can be influenced by any
 * document it reads.
 *
 * A wildcard entry (`*@example.com`) is supported because "anyone at our own
 * company" is a real and reasonable scope. `*` alone is not, on purpose.
 */
export const sendEmailTool: AgentTool = {
	name: "send_email",
	description:
		"Send a plain-text email through a configured email connection. Only addresses the connection allows can be written to; anything else is refused.",
	parameters,
	writes: true,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = parameters.parse(args)

		try {
			// A workspace that configured its own `email` connection sends through
			// that one; otherwise the deployment's. Either way the recipient
			// allowlist below is the row's, never the model's.
			const { row } = await requireIntegration("email", "email", context.workspaceId)

			if (!allowed(input.to, row.allowedRecipients)) {
				return {
					ok: false,
					content: `"${input.to}" is not on the allowed recipient list for this connection. Ask an administrator to add it.`,
					metadata: { refused: "recipient", to: input.to },
				}
			}

			// `sendMail` logs and returns when SMTP is unconfigured, and never
			// propagates a send failure — deliberately, so a bounced invitation
			// cannot roll back the invitation. That is wrong for a tool: telling
			// the model "sent" when nothing left the building would have it report
			// a delivery that did not happen. So the configuration is checked here.
			if (!env.smtp) {
				return {
					ok: false,
					content:
						"This deployment has no mail server configured, so nothing was sent.",
					metadata: { refused: "smtp_unconfigured" },
				}
			}

			await sendMail({
				to: input.to,
				subject: input.subject,
				text: input.body,
				html: asHtml(input.body),
			})
			await markUsed(row.id)

			// The body is not logged: an agent's email can quote anything it read,
			// which is exactly the material that does not belong in a log line.
			log.info("agent.email_sent", {
				runId: context.runId,
				workspaceId: context.workspaceId,
				to: input.to,
			})

			return {
				ok: true,
				content: `Email sent to ${input.to}.`,
				metadata: { to: input.to, subject: input.subject },
			}
		} catch (error) {
			return {
				ok: false,
				content: isAppError(error) ? error.message : "That email could not be sent.",
				metadata: { to: input.to, error: "send_failed" },
			}
		}
	},
}

/**
 * The agent writes plain text; the HTML part is that text escaped, not rendered.
 * An agent's body can quote anything it read, and passing that through as markup
 * would make every document it touched a way to put HTML in someone's inbox.
 */
function asHtml(text: string): string {
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
	return `<pre style="font-family:inherit;white-space:pre-wrap">${escaped}</pre>`
}

/** Exact address, or `*@domain` for a whole domain. Never a bare `*`. */
function allowed(address: string, allowlist: string[]): boolean {
	const candidate = address.toLowerCase()
	return allowlist.some((entry) => {
		const rule = entry.trim().toLowerCase()
		if (!rule || rule === "*") return false
		if (rule.startsWith("*@")) return candidate.endsWith(rule.slice(1))
		return candidate === rule
	})
}
