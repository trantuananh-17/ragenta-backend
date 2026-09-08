CREATE TABLE "agent_trigger" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"secret_hash" text,
	"secret_hint" text,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"input" text DEFAULT '' NOT NULL,
	"next_run_at" timestamp,
	"last_fired_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "agentTrigger_kind_check" CHECK ("agent_trigger"."kind" in ('webhook', 'schedule')),
	CONSTRAINT "agentTrigger_shape_check" CHECK (("agent_trigger"."kind" = 'schedule' and "agent_trigger"."cron" is not null)
				or ("agent_trigger"."kind" = 'webhook' and "agent_trigger"."secret_hash" is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_run" DROP CONSTRAINT "agentRun_trigger_check";--> statement-breakpoint
ALTER TABLE "agent_trigger" ADD CONSTRAINT "agent_trigger_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trigger" ADD CONSTRAINT "agent_trigger_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trigger" ADD CONSTRAINT "agent_trigger_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agentTrigger_agentId_name_uidx" ON "agent_trigger" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "agentTrigger_organizationId_idx" ON "agent_trigger" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agentTrigger_due_idx" ON "agent_trigger" USING btree ("kind","enabled","next_run_at");--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agentRun_trigger_check" CHECK ("agent_run"."trigger" in ('manual', 'api', 'schedule', 'webhook'));