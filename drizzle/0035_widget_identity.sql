ALTER TABLE "integration" ADD COLUMN "extra_headers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD COLUMN "encrypted_identity_secret" text;