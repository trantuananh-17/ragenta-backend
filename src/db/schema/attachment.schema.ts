import { relations, sql } from "drizzle-orm"
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { conversation, message } from "./knowledge.schema"
import { organization } from "./workspace.schema"

/**
 * A file a turn was built from: an image today, audio next, documents after
 * that.
 *
 * One polymorphic table rather than `message_image`, `message_audio` and
 * `message_file`, because every one of them is the same thing to everything
 * that touches it — an object in the bucket, a size to bill and cap, a
 * normalised extraction to put in a prompt. Three parallel tables would mean
 * three binding paths, three cleanup paths and three places to forget the
 * workspace filter. Chat and agent tools share this concept for the same
 * reason.
 *
 * `width`/`height` and `duration_ms` are the only per-kind columns, and
 * `duration_ms` is declared before anything writes it so Phase 2 audio needs no
 * migration to start recording it.
 *
 * `storage_key` is generated, never derived from `file_name` — a filename is
 * attacker-controlled and a key built from one is how a bucket ends up with
 * `../`. `file_name` is display only.
 *
 * **Both `conversation_id` and `message_id` are nullable, and that is the
 * normal state for a while.** Upload is its own request: the user picks an image
 * in the composer and it uploads immediately, but no message row exists until
 * they press send. The attachment is therefore unbound between those two
 * moments. Binding happens at send time and the service re-checks workspace
 * ownership *then* — an unbound row is not permission to attach it to anything,
 * it is only a row nobody has claimed yet.
 *
 * Known gap: an attachment that is uploaded and never sent stays unbound
 * forever. There is no reaper job yet, so orphans accumulate in Postgres and in
 * the bucket until one exists.
 */
export const messageAttachment = pgTable(
	"message_attachment",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").references(() => conversation.id, {
			onDelete: "cascade",
		}),
		messageId: text("message_id").references(() => message.id, { onDelete: "cascade" }),
		/** Who uploaded it. Set null on delete, as `message.user_id` does — the turn outlives the account. */
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

		/** image | audio | file. Decides which of the per-kind columns mean anything. */
		kind: text("kind").notNull(),

		/** Object key in the bucket. Generated from this row's id. */
		storageKey: text("storage_key").notNull(),
		/** What the uploader called it. Display only — never used to build a path. */
		fileName: text("file_name").notNull(),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),

		/** Images only. Lets the composer reserve the right space before the object loads. */
		width: integer("width"),
		height: integer("height"),
		/** Audio only, and unused until Phase 2. */
		durationMs: integer("duration_ms"),

		/**
		 * ready | processing | failed. Defaults to ready because an image that
		 * needs no extraction is usable the moment it is stored; only the kinds
		 * that go through OCR or transcription pass through `processing`.
		 */
		status: text("status").default("ready").notNull(),
		/** Why extraction failed, in words the uploader can act on. Null once it succeeds. */
		error: text("error"),

		/**
		 * The normalised OCR/vision result, kept so a re-read of the thread does
		 * not re-run — and re-bill — a vision call over an image that has not
		 * changed. Provider-shaped output is flattened into this one shape here so
		 * that prompt building never branches on which provider produced it.
		 *
		 * Untrusted: it is text a model read out of a user-supplied file, so it is
		 * data in a prompt and never instructions (`.claude/rules/security.md`).
		 */
		extracted: jsonb("extracted").$type<AttachmentExtraction>(),

		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("messageAttachment_conversationId_createdAt_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("messageAttachment_messageId_idx").on(table.messageId),
		check(
			"messageAttachment_kind_check",
			sql`${table.kind} in ('image', 'audio', 'file')`,
		),
		check(
			"messageAttachment_status_check",
			sql`${table.status} in ('ready', 'processing', 'failed')`,
		),
	],
)

export interface AttachmentExtraction {
	text: string
	/**
	 * Tables kept as HTML as well as rows: the markup carries merged cells and
	 * header spans that a rectangular array cannot, and a model reads a table far
	 * better with them than without.
	 */
	tables: Array<{ html: string; rows?: string[][] }>
	/** Key/value pairs a form-style extraction found, e.g. an invoice's totals. */
	fields: Record<string, string>
	metadata: {
		pageCount?: number
		/** 0..1. Low confidence is a reason to show the image rather than trust the text. */
		meanConfidence?: number
		/** Which provider and model produced this, so a bad extraction is traceable. */
		provider: string
		model?: string
	}
}

export const messageAttachmentRelations = relations(messageAttachment, ({ one }) => ({
	conversation: one(conversation, {
		fields: [messageAttachment.conversationId],
		references: [conversation.id],
	}),
	message: one(message, {
		fields: [messageAttachment.messageId],
		references: [message.id],
	}),
}))
