import { z } from "zod"

/**
 * An origin, as the browser sends it: scheme, host, optional port, nothing else.
 * `*.example.com` is offered as an explicit wildcard rather than inferred from a
 * bare domain, so nobody types `example.com` and gets subdomains they did not
 * mean (ADR-065).
 */
const originSchema = z
	.string()
	.trim()
	.min(8)
	.max(200)
	.regex(
		/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i,
		"Use an origin like https://shop.example.com, or https://*.example.com for subdomains.",
	)

export const saveWidgetSchema = z.object({
	id: z.string().min(1).optional(),
	agentId: z.string().min(1),
	name: z.string().trim().min(1).max(80),
	enabled: z.boolean().default(true),
	/**
	 * At least one, always. A widget with no origin accepts nothing, so saving one
	 * without is saving something that cannot work — better refused at the form
	 * than discovered on the customer's website.
	 */
	allowedOrigins: z.array(originSchema).min(1).max(20),
	greeting: z.string().trim().max(500).default(""),
	accentColor: z
		.string()
		.trim()
		.regex(/^#[0-9a-f]{6}$/i, "Use a hex colour like #7c3aed.")
		.default("#7c3aed"),
	title: z.string().trim().min(1).max(60).default("Chat"),
	quickQuestions: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
	placeholder: z.string().trim().min(1).max(80).default("Type a message…"),
	launcherLabel: z.string().trim().max(40).default(""),
	position: z.enum(["right", "left"]).default("right"),
	language: z.enum(["en", "vi"]).default("en"),
	/** Credits this widget may spend in a UTC day. The money guard. */
	dailyCreditCeiling: z.number().min(1_000).max(10_000_000).default(50_000),
	visitorHourlyLimit: z.number().int().min(1).max(200).default(20),
})

export const widgetMessageSchema = z.object({
	message: z.string().trim().min(1).max(2_000),
	/** Continues an existing conversation. Absent starts one. */
	conversationId: z.string().min(1).optional(),
	/**
	 * Who the host site says this is, signed by the host's server with the
	 * widget's identity secret. Absent is an anonymous visitor; present but
	 * unsigned or mis-signed is refused, never downgraded to anonymous.
	 */
	visitor: z
		.object({
			id: z.string().trim().min(1).max(200),
			email: z.string().trim().email().max(320).optional(),
			hash: z.string().trim().regex(/^[0-9a-f]{64}$/i, "hash must be hex HMAC-SHA256"),
		})
		.optional(),
})

export type SaveWidgetInput = z.infer<typeof saveWidgetSchema>
