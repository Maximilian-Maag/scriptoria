-- `admin_groups` became `root_groups` in `schema.ts` when the role did — "root
-- account", not "admin" — and `ad_group` became `directory_group` in both this
-- table and `area_entitlements`, because a group here is a *reference* to a
-- directory group and never an Active Directory copy (FA-02.3, NFR-04). No
-- migration was ever generated for any of it.
--
-- Nothing noticed, because the dev database's schema arrived through
-- `drizzle-kit push` rather than through this journal. A database built from
-- these migrations got the old names, `make db-seed` then failed on its first
-- insert, and the platform came up with no way to reach administration at all.
-- The e2e suite is what found it: it is the only thing that migrates a database
-- from empty.
--
-- Renames rather than drops and creates: these rows decide who may administer
-- the platform and which groups reach which area, and a migration that quietly
-- discarded them would lock everybody out of any environment that had them.
ALTER TABLE "admin_groups" RENAME TO "root_groups";--> statement-breakpoint
ALTER TABLE "root_groups" RENAME COLUMN "ad_group" TO "directory_group";--> statement-breakpoint
ALTER INDEX "admin_groups_unique" RENAME TO "root_groups_unique";--> statement-breakpoint
-- Postgres does not rename a constraint with its table, and drizzle does not
-- track the name, so this one is invisible to the schema diff and would
-- otherwise survive as the only trace of the old name.
ALTER INDEX "admin_groups_pkey" RENAME TO "root_groups_pkey";--> statement-breakpoint
ALTER TABLE "area_entitlements" RENAME COLUMN "ad_group" TO "directory_group";
