ALTER TABLE "agent_run" DROP CONSTRAINT "agentRun_trigger_check";--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "widget_id" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agentRun_trigger_check" CHECK ("agent_run"."trigger" in ('manual', 'api', 'schedule', 'webhook', 'widget'));