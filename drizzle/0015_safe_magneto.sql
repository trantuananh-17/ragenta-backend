ALTER TABLE "agent_run" DROP CONSTRAINT "agentRun_status_check";--> statement-breakpoint
ALTER TABLE "agent_run" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agentRun_status_check" CHECK ("agent_run"."status" in ('pending', 'running', 'awaiting_input', 'succeeded', 'failed', 'stopped'));