-- The server connects as app, not as the owner (S3, Q1). Roles are cluster-wide, so a role left
-- by another database on the same cluster (a test database, a restored dump) is kept as it is.
-- runMigrations holds the role lock around this step. LOGIN and the password come from
-- setAppRolePassword in ops migrate, never from a migration.
DO $$ BEGIN
  CREATE ROLE app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER ROLE app SET statement_timeout = '2s';
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO app;
--> statement-breakpoint
-- SELECT because ON CONFLICT DO UPDATE reads the existing row and RETURNING reads xmax. No DELETE,
-- no TRUNCATE, nothing on ebay_quota_window. Every later table migration adds its own grants.
GRANT SELECT, INSERT, UPDATE ON app.deletion_event, app.deletion_result_hourly, app.api_usage_hourly, app.probe_seen TO app;
