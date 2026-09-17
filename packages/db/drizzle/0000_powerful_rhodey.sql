CREATE TYPE "public"."abort_stage" AS ENUM('sigint', 'sigterm', 'sigkill');--> statement-breakpoint
CREATE TYPE "public"."area_category" AS ENUM('one-off', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."criticality" AS ENUM('read-only', 'modifying', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."run_event_kind" AS ENUM('queued', 'claimed', 'connected', 'pty_opened', 'started', 'abort_requested', 'abort_signalled', 'exited', 'collected', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'starting', 'running', 'succeeded', 'failed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('manual', 'scheduled');--> statement-breakpoint
CREATE TABLE "admin_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_group" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "area_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"ad_group" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" "area_category" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"area_id" uuid,
	"run_id" uuid,
	"outcome" "audit_outcome" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_ip" text
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "run_event_kind" NOT NULL,
	"stage" "abort_stage",
	"message" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"content_type" text NOT NULL,
	"modified_at" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_transcripts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"persisted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"script_file_name" text NOT NULL,
	"script_title" text NOT NULL,
	"criticality" "criticality" NOT NULL,
	"host" text NOT NULL,
	"output_path" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"trigger" "run_trigger" DEFAULT 'manual' NOT NULL,
	"started_by" text NOT NULL,
	"worker_id" text,
	"cols" integer DEFAULT 80 NOT NULL,
	"rows" integer DEFAULT 24 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"failure_reason" text,
	"last_stream_id" text,
	"abort_requested_by" text,
	"abort_requested_at" timestamp with time zone,
	"abort_stage" "abort_stage",
	"result_count" integer
);
--> statement-breakpoint
CREATE TABLE "script_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"script_path" text NOT NULL,
	"output_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"absolute_path" text NOT NULL,
	"header" jsonb,
	"criticality_override" "criticality",
	"criticality_override_reason" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"modified_at" timestamp with time zone,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"present_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "area_entitlements" ADD CONSTRAINT "area_entitlements_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_transcripts" ADD CONSTRAINT "run_transcripts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_sources" ADD CONSTRAINT "script_sources_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_source_id_script_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."script_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_groups_unique" ON "admin_groups" USING btree (lower("ad_group"));--> statement-breakpoint
CREATE INDEX "area_entitlements_area_idx" ON "area_entitlements" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "area_entitlements_unique" ON "area_entitlements" USING btree ("area_id",lower("ad_group"));--> statement-breakpoint
CREATE UNIQUE INDEX "areas_name_key" ON "areas" USING btree ("name");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_run_idx" ON "audit_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_results_unique" ON "run_results" USING btree ("run_id","path");--> statement-breakpoint
CREATE INDEX "runs_area_queued_idx" ON "runs" USING btree ("area_id","queued_at");--> statement-breakpoint
CREATE INDEX "runs_script_idx" ON "runs" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_started_by_idx" ON "runs" USING btree ("started_by");--> statement-breakpoint
CREATE INDEX "script_sources_area_idx" ON "script_sources" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "script_sources_unique" ON "script_sources" USING btree ("area_id","host","script_path");--> statement-breakpoint
CREATE INDEX "scripts_area_idx" ON "scripts" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scripts_source_file_key" ON "scripts" USING btree ("source_id","file_name");