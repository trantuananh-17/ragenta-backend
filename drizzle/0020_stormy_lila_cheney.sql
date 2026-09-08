CREATE TABLE "agent_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"embedding_model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentMemory_source_check" CHECK ("agent_memory"."source" in ('tool', 'summary'))
);
--> statement-breakpoint
ALTER TABLE "agent_version" ADD COLUMN "memory_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_version" ADD COLUMN "memory_scope" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_version" ADD COLUMN "memory_top_k" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agentMemory_agentId_userId_idx" ON "agent_memory" USING btree ("agent_id","user_id");--> statement-breakpoint
CREATE INDEX "agentMemory_organizationId_idx" ON "agent_memory" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agentMemory_agentId_createdAt_idx" ON "agent_memory" USING btree ("agent_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agentVersion_memoryScope_check" CHECK ("agent_version"."memory_scope" in ('agent', 'user'));