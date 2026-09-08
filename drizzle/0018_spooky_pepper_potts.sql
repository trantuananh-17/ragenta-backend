CREATE TABLE "member_role" (
	"member_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "member_role_member_id_role_id_pk" PRIMARY KEY("member_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"description" text NOT NULL,
	"grantable_on" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "permission_scope_check" CHECK ("permission"."scope" in ('workspace', 'platform')),
	CONSTRAINT "permission_grantable_on_check" CHECK ("permission"."grantable_on" is null or "permission"."grantable_on" in ('project', 'knowledgeBase', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "resource_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "resourceGrant_subjectType_check" CHECK ("resource_grant"."subject_type" in ('member', 'role')),
	CONSTRAINT "resourceGrant_resourceType_check" CHECK ("resource_grant"."resource_type" in ('project', 'knowledgeBase', 'agent')),
	CONSTRAINT "resourceGrant_effect_check" CHECK ("resource_grant"."effect" in ('allow', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "role_scope_check" CHECK ("role"."scope" in ('workspace', 'platform')),
	CONSTRAINT "role_platform_has_no_organization_check" CHECK ("role"."scope" <> 'platform' or "role"."organization_id" is null)
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"role_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "user_platform_role" (
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "user_platform_role_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grant" ADD CONSTRAINT "resource_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grant" ADD CONSTRAINT "resource_grant_permission_key_permission_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grant" ADD CONSTRAINT "resource_grant_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_key_permission_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_platform_role" ADD CONSTRAINT "user_platform_role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_platform_role" ADD CONSTRAINT "user_platform_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_platform_role" ADD CONSTRAINT "user_platform_role_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberRole_roleId_idx" ON "member_role" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "permission_scope_idx" ON "permission" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "resourceGrant_unique_uidx" ON "resource_grant" USING btree ("organization_id","subject_type","subject_id","resource_type","resource_id","permission_key");--> statement-breakpoint
CREATE INDEX "resourceGrant_lookup_idx" ON "resource_grant" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resourceGrant_subject_idx" ON "resource_grant" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_workspace_key_uidx" ON "role" USING btree ("organization_id","key") WHERE organization_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "role_global_key_uidx" ON "role" USING btree ("scope","key") WHERE organization_id is null;--> statement-breakpoint
CREATE INDEX "role_organizationId_idx" ON "role" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "rolePermission_permissionKey_idx" ON "role_permission" USING btree ("permission_key");--> statement-breakpoint
CREATE INDEX "userPlatformRole_roleId_idx" ON "user_platform_role" USING btree ("role_id");