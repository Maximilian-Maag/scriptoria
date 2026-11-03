-- The end of a collection, recorded rather than inferred (ADR-011).
--
-- Nullable, and with no default: "not collected yet" is the correct reading of
-- every existing row, and this is the column a view polls on.
--
-- The backfill is the half that matters for an upgrade. Every run that has
-- already finished cannot still be collecting anything, and a terminal run with
-- no count and no collection end is exactly the shape the interface reads as
-- "still working" — so without this every historical run that failed to collect
-- would be polled for as long as somebody left the tab open.
ALTER TABLE "runs" ADD COLUMN "collected_at" timestamp with time zone;--> statement-breakpoint
UPDATE "runs" SET "collected_at" = "finished_at" WHERE "finished_at" IS NOT NULL AND "result_count" IS NULL;
