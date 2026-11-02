-- The directory group columns, renamed to what the schema calls them.
--
-- 0000 was generated while these were still the AD-flavoured names and the
-- schema moved on without a migration, so a database built by `make
-- db-migrate` had `admin_groups.ad_group` and `area_entitlements.ad_group`
-- while `schema.ts` read `root_groups.directory_group` and
-- `area_entitlements.directory_group`. Nobody could sign in: the login path
-- reads both tables.
--
-- Written as renames rather than as a drop and re-create, and added rather than
-- folded into 0000: this must be a no-op for the data (`make db-seed` puts the
-- root group back, but an entitlement an administrator created by hand is
-- theirs, not ours), and rewriting 0000 in place would re-apply it — and fail on
-- CREATE TABLE — on every database that has already run it.
ALTER TABLE "admin_groups" RENAME TO "root_groups";--> statement-breakpoint
ALTER TABLE "root_groups" RENAME COLUMN "ad_group" TO "directory_group";--> statement-breakpoint
ALTER TABLE "area_entitlements" RENAME COLUMN "ad_group" TO "directory_group";--> statement-breakpoint
ALTER INDEX "admin_groups_unique" RENAME TO "root_groups_unique";
