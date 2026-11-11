ALTER TABLE "runs" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "runs_host_status_idx" ON "runs" USING btree ("host","status");
