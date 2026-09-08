import { z } from "zod"

/**
 * A trigger, as somebody configures it.
 *
 * The two kinds share a schema because they share every field but two, and the
 * database's own CHECK is what refuses a schedule with no cron or a webhook with
 * no secret — a row that looks configured and is not should be impossible at the
 * storage layer, not only at the one boundary that remembered (ADR-058).
 */
export const saveTriggerSchema = z.object({
	kind: z.enum(["webhook", "schedule"]),
	name: z.string().trim().min(1).max(80),
	enabled: z.boolean().default(true),
	/**
	 * What the agent is asked. Required for a schedule — a schedule with nothing
	 * to ask is one that runs and produces nothing — and the fallback for a
	 * webhook whose body is empty.
	 */
	input: z.string().trim().max(8_000).default(""),
	/** Five fields. Six are refused; see `schedule.ts`. */
	cron: z.string().trim().min(1).max(120).optional(),
	/**
	 * An IANA zone. Defaulting to UTC rather than to the server's own is
	 * deliberate: a server's zone is an accident of where it was provisioned, and
	 * a schedule that moved when the VM did would be very hard to explain.
	 */
	timezone: z.string().trim().min(1).max(64).default("UTC"),
})

export type SaveTriggerInput = z.infer<typeof saveTriggerSchema>
