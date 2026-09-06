CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_status_check" CHECK ("agent"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version_id" text NOT NULL,
	"project_id" text,
	"user_id" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" text,
	"error" text,
	"credits" numeric(14, 4) DEFAULT '0' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentRun_status_check" CHECK ("agent_run"."status" in ('running', 'succeeded', 'failed', 'stopped')),
	CONSTRAINT "agentRun_trigger_check" CHECK ("agent_run"."trigger" in ('manual', 'api', 'schedule'))
);
--> statement-breakpoint
CREATE TABLE "agent_run_step" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"credits" numeric(14, 4) DEFAULT '0' NOT NULL,
	"usage_reference" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "agentRunStep_kind_check" CHECK ("agent_run_step"."kind" in ('model', 'retrieval')),
	CONSTRAINT "agentRunStep_status_check" CHECK ("agent_run_step"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "agent_version" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"instructions" text NOT NULL,
	"provider" text,
	"model" text,
	"temperature" numeric(3, 2),
	"max_output_tokens" integer,
	"knowledge_base_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_mode" text DEFAULT 'hybrid' NOT NULL,
	"top_k" integer,
	"similarity_threshold" numeric(4, 3),
	"vector_weight" numeric(4, 3),
	"rerank_provider" text,
	"rerank_model" text,
	"grounded_only" boolean DEFAULT true NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_rounds" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentVersion_searchMode_check" CHECK ("agent_version"."search_mode" in ('hybrid', 'vector', 'keyword'))
);
--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_agent_version_id_agent_version_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD CONSTRAINT "agent_run_step_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_organizationId_name_uidx" ON "agent" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "agent_organizationId_updatedAt_idx" ON "agent" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "agentRun_organizationId_createdAt_idx" ON "agent_run" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agentRun_agentId_createdAt_idx" ON "agent_run" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agentRunStep_runId_seq_uidx" ON "agent_run_step" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agentVersion_agentId_version_uidx" ON "agent_version" USING btree ("agent_id","version");