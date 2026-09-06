CREATE TABLE "conversation_knowledge_base" (
	"conversation_id" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	CONSTRAINT "conversation_knowledge_base_conversation_id_knowledge_base_id_pk" PRIMARY KEY("conversation_id","knowledge_base_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_task" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"document_id" text NOT NULL,
	"task_type" text DEFAULT 'parse' NOT NULL,
	"from_page" integer,
	"to_page" integer,
	"digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" numeric(5, 4) DEFAULT '0' NOT NULL,
	"progress_message" text,
	"error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "ingestionTask_taskType_check" CHECK ("ingestion_task"."task_type" in ('parse', 'raptor'))
);
--> statement-breakpoint
ALTER TABLE "provider_model" DROP CONSTRAINT "providerModel_capability_check";--> statement-breakpoint
DROP INDEX "chunk_content_fts_idx";--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "kind" text DEFAULT 'passage' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "keywords" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "questions" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "parent_chunk_id" text;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "from_page" integer;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "to_page" integer;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "digest" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "search_mode" text DEFAULT 'hybrid' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "top_k" integer;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "similarity_threshold" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "vector_weight" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "rerank_provider" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "rerank_model" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "parser_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "parser_config" jsonb;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "progress" numeric(5, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "progress_message" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "process_began_at" timestamp;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "process_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "parser_id" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "parser_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "top_k" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "similarity_threshold" numeric(4, 3) DEFAULT '0.200' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "vector_weight" numeric(4, 3) DEFAULT '0.700' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "rerank_provider" text;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "rerank_model" text;--> statement-breakpoint
ALTER TABLE "conversation_knowledge_base" ADD CONSTRAINT "conversation_knowledge_base_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_knowledge_base" ADD CONSTRAINT "conversation_knowledge_base_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_task" ADD CONSTRAINT "ingestion_task_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_task" ADD CONSTRAINT "ingestion_task_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_task" ADD CONSTRAINT "ingestion_task_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversationKnowledgeBase_knowledgeBaseId_idx" ON "conversation_knowledge_base" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "ingestionTask_documentId_attempt_idx" ON "ingestion_task" USING btree ("document_id","attempt");--> statement-breakpoint
CREATE INDEX "ingestionTask_digest_idx" ON "ingestion_task" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "chunk_documentId_digest_idx" ON "chunk" USING btree ("document_id","digest");--> statement-breakpoint
CREATE INDEX "chunk_content_fts_idx" ON "chunk" USING gin (to_tsvector('simple', "content" || ' ' || coalesce("question", '') || ' ' || array_to_string("keywords", ' ') || ' ' || array_to_string("questions", ' ')));--> statement-breakpoint
ALTER TABLE "provider_model" ADD CONSTRAINT "providerModel_capability_check" CHECK ("provider_model"."capability" in ('chat', 'embedding', 'rerank'));--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_searchMode_check" CHECK ("conversation"."search_mode" in ('hybrid', 'vector', 'keyword'));