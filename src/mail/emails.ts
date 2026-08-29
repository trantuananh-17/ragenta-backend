import { env } from "../config/env"
import { sendMail } from "./mailer"

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

function layout(title: string, body: string, action?: { label: string; url: string }) {
	return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h1>
      ${body}
      ${
				action
					? `<p style="margin:24px 0"><a href="${action.url}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px">${escapeHtml(action.label)}</a></p>
      <p style="margin:0;font-size:12px;color:#6b7280">If the button does not work, paste this link into your browser:<br>${action.url}</p>`
					: ""
			}
    </div>
  </body>
</html>`
}

export async function sendPasswordResetEmail(to: string, url: string) {
	await sendMail({
		to,
		subject: "Reset your Ragenta password",
		html: layout(
			"Reset your password",
			"<p>We received a request to reset your Ragenta password. This link expires in one hour. If you did not ask for it, you can ignore this email.</p>",
			{ label: "Reset password", url },
		),
		text: `Reset your Ragenta password: ${url}`,
	})
}

export async function sendEmailVerificationEmail(to: string, url: string) {
	await sendMail({
		to,
		subject: "Verify your Ragenta email address",
		html: layout(
			"Verify your email",
			"<p>Confirm this address to finish setting up your Ragenta account.</p>",
			{ label: "Verify email", url },
		),
		text: `Verify your Ragenta email address: ${url}`,
	})
}

export async function sendWorkspaceInvitationEmail(params: {
	to: string
	workspaceName: string
	inviterName: string
	inviterEmail: string
	role: string
	invitationId: string
}) {
	const url = `${env.appBaseUrl}/accept-invitation/${params.invitationId}`
	await sendMail({
		to: params.to,
		subject: `${params.inviterName} invited you to ${params.workspaceName} on Ragenta`,
		html: layout(
			`Join ${params.workspaceName}`,
			`<p>${escapeHtml(params.inviterName)} (${escapeHtml(params.inviterEmail)}) invited you to the
      <strong>${escapeHtml(params.workspaceName)}</strong> workspace as <strong>${escapeHtml(params.role)}</strong>.</p>`,
			{ label: "Accept invitation", url },
		),
		text: `${params.inviterName} invited you to ${params.workspaceName} on Ragenta: ${url}`,
	})
}
