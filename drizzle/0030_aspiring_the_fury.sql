ALTER TABLE "agent_run" DROP CONSTRAINT "agentRun_trigger_check";--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "comparison_id" text;--> statement-breakpoint
CREATE INDEX "agentRun_comparisonId_idx" ON "agent_run" USING btree ("comparison_id");--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agentRun_trigger_check" CHECK ("agent_run"."trigger" in ('manual', 'api', 'schedule', 'webhook', 'widget', 'comparison'));