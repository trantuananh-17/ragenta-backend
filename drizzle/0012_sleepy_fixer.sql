ALTER TABLE "agent_run" DROP CONSTRAINT "agentRun_status_check";--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD COLUMN "node_id" text;--> statement-breakpoint
ALTER TABLE "agent_version" ADD COLUMN "graph" jsonb;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agentRun_status_check" CHECK ("agent_run"."status" in ('running', 'awaiting_input', 'succeeded', 'failed', 'stopped'));