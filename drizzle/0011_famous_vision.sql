ALTER TABLE "agent_run_step" DROP CONSTRAINT "agentRunStep_kind_check";--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "agent_version" ADD COLUMN "credit_ceiling" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD CONSTRAINT "agentRunStep_kind_check" CHECK ("agent_run_step"."kind" in ('model', 'retrieval', 'tool'));