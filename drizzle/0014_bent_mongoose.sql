CREATE TABLE "message_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"user_id" text,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"status" text DEFAULT 'ready' NOT NULL,
	"error" text,
	"extracted" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messageAttachment_kind_check" CHECK ("message_attachment"."kind" in ('image', 'audio', 'file')),
	CONSTRAINT "messageAttachment_status_check" CHECK ("message_attachment"."status" in ('ready', 'processing', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messageAttachment_conversationId_createdAt_idx" ON "message_attachment" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messageAttachment_messageId_idx" ON "message_attachment" USING btree ("message_id");