ALTER TABLE "chat_widget" ADD COLUMN "quick_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD COLUMN "placeholder" text DEFAULT 'Type a message…' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD COLUMN "launcher_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD COLUMN "position" text DEFAULT 'right' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD CONSTRAINT "chatWidget_position_check" CHECK ("chat_widget"."position" in ('right', 'left'));--> statement-breakpoint
ALTER TABLE "chat_widget" ADD CONSTRAINT "chatWidget_language_check" CHECK ("chat_widget"."language" in ('en', 'vi'));