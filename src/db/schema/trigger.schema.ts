import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { agent } from "./agent.schema"
import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * What starts a run when nobody is watching.
 *
 * Two kinds, and they are one table because they differ only in what fires them:
 * both resolve to the same thing — an input, an agent, and `enqueueAgentRun`.
 * Separate tables would mean the run-starting path existed twice, and the second
 * copy is the one that forgets the credit check (ADR-058).
 */
export const agentTrigger = pgTable(
	"agent_trigger",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		agentId: text("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),

		/** webhook | schedule */
		kind: text("kind").notNull(),
		name: text("name").notNull(),
		/** Off keeps the row and its secret while making the trigger fire nothing. */
		enabled: boolean("enabled").default(true).notNull(),

		/**
		 * The shared secret a webhook's caller signs its body with.
		 *
		 * Stored as a **hash**, not encrypted: this is a credential the caller
		 * presents, like an API key, so it is verified rather than replayed and
		 * there is no reason for the plaintext to survive the response that showed
		 * it once (`.claude/rules/security.md`).
		 */
		secretHash: text("secret_hash"),
		/** The first characters, so somebody can tell two webhooks apart on a screen. */
		secretHint: text("secret_hint"),

		/**
		 * A five-field cron expression and the zone it is read in.
		 *
		 * The zone matters and is not cosmetic: "every weekday at 09:00" means a
		 * different instant in Hanoi than in London, and a schedule that silently
		 * ran in UTC would be wrong for everybody outside it by up to a day.
		 */
		cron: text("cron"),
		timezone: text("timezone").default("UTC").notNull(),

		/**
		 * What the agent is asked, for a schedule; for a webhook, the fallback when
		 * the payload carries nothing usable.
		 */
		input: text("input").default("").notNull(),

		/**
		 * When this trigger is next due, in UTC.
		 *
		 * Materialised rather than computed on every scan: the scan is one indexed
		 * range query over every workspace's triggers, and evaluating a cron
		 * expression per row to decide would make the scan's cost grow with the
		 * number of triggers rather than with the number that are due.
		 */
		nextRunAt: timestamp("next_run_at"),
		lastFiredAt: timestamp("last_fired_at"),
		/** Consecutive failures, so a broken trigger can be backed off rather than retried forever. */
		failureCount: integer("failure_count").default(0).notNull(),
		lastError: text("last_error"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("agentTrigger_kind_check", sql`${table.kind} in ('webhook', 'schedule')`),
		// A schedule with no cron never fires and a webhook with no secret accepts
		// anybody's POST. Both are rows that look configured and are not, so the
		// database refuses them rather than leaving it to whichever writer
		// remembers.
		check(
			"agentTrigger_shape_check",
			sql`(${table.kind} = 'schedule' and ${table.cron} is not null)
				or (${table.kind} = 'webhook' and ${table.secretHash} is not null)`,
		),
		uniqueIndex("agentTrigger_agentId_name_uidx").on(table.agentId, table.name),
		index("agentTrigger_organizationId_idx").on(table.organizationId),
		// The scan's own index: enabled schedules that are due, and nothing else.
		index("agentTrigger_due_idx").on(table.kind, table.enabled, table.nextRunAt),
	],
)

export const agentTriggerRelations = relations(agentTrigger, ({ one }) => ({
	organization: one(organization, {
		fields: [agentTrigger.organizationId],
		references: [organization.id],
	}),
	agent: one(agent, { fields: [agentTrigger.agentId], references: [agent.id] }),
}))
