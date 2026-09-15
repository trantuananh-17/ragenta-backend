ALTER TABLE "agent_run" ADD COLUMN "visitor_id" text;--> statement-breakpoint
CREATE INDEX "agentRun_widget_visitor_idx" ON "agent_run" USING btree ("widget_id","visitor_id","created_at");