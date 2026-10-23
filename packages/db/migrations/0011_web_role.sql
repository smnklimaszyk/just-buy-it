-- Spec 2.10. The admin UI and the sign-in connect as web, like app and worker before (0003,
-- 0005). Roles are cluster-wide, so a role left by another database on the same cluster is kept as
-- it is. runMigrations holds the role lock around this step. LOGIN and the password come from
-- ops migrate (POSTGRES_WEB_PASSWORD), never from a migration.
DO $$ BEGIN
  CREATE ROLE web NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER ROLE web SET statement_timeout = '2s';
--> statement-breakpoint
GRANT USAGE ON SCHEMA app, auth, ebay_live TO web;
--> statement-breakpoint
-- What today's dashboard reads (0005), with the same column limits.
GRANT SELECT ON
  app.feed, app.segment_rule, app.poll_run, app.candidate, app.screening, app.llm_usage_daily,
  app.alert, app.alert_delivery, app.price_sample, app.purge_run, app.worker_status,
  app.screening_pause, app.smtp_pause, app.api_usage_hourly,
  ebay_live.classifier_sample, ebay_live.screening_text
  TO web;
--> statement-breakpoint
GRANT SELECT (feed_id, segment, outcome, first_seen_at, last_seen_at) ON app.seen_item TO web;
--> statement-breakpoint
GRANT SELECT (resource, window_start, window_end, limit_total, used, used_alert_path, used_standard)
  ON app.ebay_quota_window TO web;
--> statement-breakpoint
GRANT SELECT (id, legacy_item_id, segment, content_expires_at, gone_at) ON ebay_live.listing TO web;
--> statement-breakpoint
GRANT SELECT (listing_id, title, content_expires_at) ON ebay_live.listing_content TO web;
--> statement-breakpoint
-- Products, searches and settings are saved from the form, in one transaction with the revision
-- and the audit row. Searches are retired, never deleted; only their memberships are rewritten.
GRANT SELECT, INSERT, UPDATE ON
  app.product, app.product_source, app.search, app.setting, app.market_request, app.category_request
  TO web;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON app.search_product TO web;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE app.search_id_seq TO web;
--> statement-breakpoint
-- Append-only for web: revisions and the audit log are read, never changed.
GRANT SELECT, INSERT ON app.product_revision, app.audit_event TO web;
--> statement-breakpoint
GRANT SELECT ON
  app.market_listing, app.market_value, app.market_daily, app.market_run, app.llm_usage_product_daily,
  ebay_live.market_preview
  TO web;
--> statement-breakpoint
-- Sign-in. No DELETE on any auth table: web cannot remove its own trail; the worker purges.
GRANT SELECT, INSERT, UPDATE ON auth.app_user, auth.login_attempt, auth.session, auth.device, auth.rate_counter TO web;
--> statement-breakpoint
GRANT SELECT, INSERT ON auth.auth_event TO web;
--> statement-breakpoint
-- Only the worker reserves eBay calls. It has its own grant (0005); PUBLIC had one by default.
REVOKE EXECUTE ON FUNCTION app.reserve_ebay_call(text, text, text, integer, timestamptz) FROM PUBLIC;
--> statement-breakpoint
-- The worker's rights on the v2 tables. Only grants are added; nothing of 0005 changes.
GRANT USAGE ON SCHEMA auth TO worker;
--> statement-breakpoint
-- Tables the worker writes and its purge covers.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.market_listing, app.market_run, app.llm_usage_product_daily, ebay_live.market_preview
  TO worker;
--> statement-breakpoint
-- Market values: the price columns are set to NULL after 30 days; nothing else is ever updated.
GRANT SELECT, INSERT, DELETE ON app.market_value TO worker;
--> statement-breakpoint
GRANT UPDATE (m_cents, p25_cents, p75_cents, lo_cents, hi_cents, value_cents) ON app.market_value TO worker;
--> statement-breakpoint
-- Requests come from web; the worker moves them to done or refused and purges them after 7 days.
GRANT SELECT, DELETE ON app.market_request, app.category_request TO worker;
--> statement-breakpoint
GRANT UPDATE (status, done_at) ON app.market_request TO worker;
--> statement-breakpoint
GRANT UPDATE (status, result, done_at) ON app.category_request TO worker;
--> statement-breakpoint
-- One row per Berlin day, overwritten, never deleted.
GRANT SELECT, INSERT, UPDATE ON app.market_daily TO worker;
--> statement-breakpoint
-- Config: read on every job, written by web and ops. The category name comes from a snapshot.
GRANT SELECT ON
  app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting
  TO worker;
--> statement-breakpoint
GRANT UPDATE (category_name) ON app.product TO worker;
--> statement-breakpoint
-- send reads who gets an alert and keeps only active people. Nothing else of a person.
GRANT SELECT (id, email, status) ON auth.app_user TO worker;
--> statement-breakpoint
-- The purge of the auth tables (ADR 0038). DELETE and the columns its conditions read, ctid
-- included because the purge deletes in batches by ctid. Never a code, token or address column.
GRANT DELETE ON auth.login_attempt, auth.session, auth.device, auth.rate_counter, auth.auth_event TO worker;
--> statement-breakpoint
GRANT SELECT (ctid, created_at) ON auth.login_attempt TO worker;
--> statement-breakpoint
GRANT SELECT (ctid, ended_at, expires_at) ON auth.session TO worker;
--> statement-breakpoint
GRANT SELECT (ctid, revoked_at, last_used_at) ON auth.device TO worker;
--> statement-breakpoint
GRANT SELECT (ctid, window_start) ON auth.rate_counter TO worker;
--> statement-breakpoint
GRANT SELECT (ctid, at) ON auth.auth_event TO worker;
