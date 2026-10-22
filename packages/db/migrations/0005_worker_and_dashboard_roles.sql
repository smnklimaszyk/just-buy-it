-- The worker and the dashboard connect as their own roles (section 2.5). Roles are cluster-wide, so
-- a role left by another database on the same cluster is kept as it is. runMigrations holds the
-- role lock around this step. LOGIN and the passwords come from ops migrate, never from a migration.
DO $$ BEGIN
  CREATE ROLE worker NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE ROLE dashboard NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER ROLE worker SET statement_timeout = '10s';
--> statement-breakpoint
ALTER ROLE dashboard SET statement_timeout = '2s';
--> statement-breakpoint
ALTER ROLE dashboard SET default_transaction_read_only = on;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app, ebay_live TO worker, dashboard;
--> statement-breakpoint
-- Worker: full rights on the tables its purge covers (section 7.3), and only there DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  ebay_live.listing, ebay_live.listing_content, ebay_live.classifier_sample, ebay_live.screening_text,
  ebay_live.alert_message,
  app.seen_item, app.price_sample, app.poll_run, app.candidate, app.screening, app.alert,
  app.alert_delivery, app.llm_usage_daily, app.purge_run
  TO worker;
--> statement-breakpoint
-- Its one-row tables are overwritten, never deleted.
GRANT SELECT, INSERT, UPDATE ON app.screening_pause, app.smtp_pause, app.worker_status TO worker;
--> statement-breakpoint
-- Config is changed by ops only.
GRANT SELECT ON app.feed, app.segment_rule TO worker;
--> statement-breakpoint
-- reserve_ebay_call runs with the caller's rights and writes these two tables. No DELETE.
GRANT SELECT, INSERT, UPDATE ON app.ebay_quota_window, app.api_usage_hourly TO worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reserve_ebay_call(text, text, text, integer, timestamptz) TO worker;
--> statement-breakpoint
-- Dashboard: SELECT on exactly what the pages show (section 8.2). Nothing on deletion_event,
-- deletion_result_hourly, probe_seen, audit_event, alert_message or pgboss.
GRANT SELECT ON
  app.feed, app.segment_rule, app.poll_run, app.candidate, app.screening, app.llm_usage_daily,
  app.alert, app.alert_delivery, app.price_sample, app.purge_run, app.worker_status,
  app.screening_pause, app.smtp_pause, app.api_usage_hourly,
  ebay_live.classifier_sample, ebay_live.screening_text
  TO dashboard;
--> statement-breakpoint
GRANT SELECT (feed_id, segment, outcome, first_seen_at, last_seen_at) ON app.seen_item TO dashboard;
--> statement-breakpoint
GRANT SELECT (resource, window_start, window_end, limit_total, used, used_alert_path, used_standard)
  ON app.ebay_quota_window TO dashboard;
--> statement-breakpoint
GRANT SELECT (id, legacy_item_id, segment, content_expires_at, gone_at) ON ebay_live.listing TO dashboard;
--> statement-breakpoint
GRANT SELECT (listing_id, title, content_expires_at) ON ebay_live.listing_content TO dashboard;
