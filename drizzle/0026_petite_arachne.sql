CREATE TABLE "data_query" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"data_source_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"sql" text NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"row_limit" integer DEFAULT 50 NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"approved_at" timestamp,
	"approved_by" text,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "dataQuery_origin_check" CHECK ("data_query"."origin" in ('manual', 'generated')),
	CONSTRAINT "dataQuery_rowLimit_check" CHECK ("data_query"."row_limit" between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "data_source" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"encrypted_dsn" text NOT NULL,
	"dsn_hint" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schema_cache" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_cached_at" timestamp,
	"last_checked_at" timestamp,
	"last_check_ok" boolean,
	"last_check_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "dataSource_engine_check" CHECK ("data_source"."engine" in ('postgres', 'mysql'))
);
--> statement-breakpoint
ALTER TABLE "data_query" ADD CONSTRAINT "data_query_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_query" ADD CONSTRAINT "data_query_data_source_id_data_source_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_query" ADD CONSTRAINT "data_query_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_query" ADD CONSTRAINT "data_query_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dataQuery_dataSourceId_name_uidx" ON "data_query" USING btree ("data_source_id","name");--> statement-breakpoint
CREATE INDEX "dataQuery_organizationId_idx" ON "data_query" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataSource_organizationId_name_uidx" ON "data_source" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "dataSource_organizationId_idx" ON "data_source" USING btree ("organization_id");