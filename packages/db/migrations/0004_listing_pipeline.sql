CREATE SCHEMA "ebay_live";
--> statement-breakpoint
CREATE TABLE "app"."alert" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_key" text NOT NULL,
	"seq" smallint DEFAULT 1 NOT NULL,
	"candidate_id" uuid NOT NULL,
	"screening_id" uuid,
	"kind" text DEFAULT 'band' NOT NULL,
	"tier" text DEFAULT 'none' NOT NULL,
	"segment" text NOT NULL,
	"final_verdict" text NOT NULL,
	"model_verdict" text,
	"blocked_by_code" boolean NOT NULL,
	"screened" boolean NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"price_cents" integer,
	"shipping_cents" integer,
	"landed_cents" integer,
	"rule_version" integer NOT NULL,
	"buyer_profile" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_item_key_seq_unique" UNIQUE("item_key","seq"),
	CONSTRAINT "alert_seq_positive" CHECK ("app"."alert"."seq" >= 1),
	CONSTRAINT "alert_kind_known" CHECK ("app"."alert"."kind" IN ('band', 'instant', 'auction_bid', 'trial')),
	CONSTRAINT "alert_tier_known" CHECK ("app"."alert"."tier" IN ('none', 'no_brainer', 'good', 'fair', 'above_market', 'unrated')),
	CONSTRAINT "alert_final_verdict_known" CHECK ("app"."alert"."final_verdict" IN ('pass', 'caution', 'block')),
	CONSTRAINT "alert_model_verdict_known" CHECK ("app"."alert"."model_verdict" IS NULL OR "app"."alert"."model_verdict" IN ('pass', 'caution', 'block')),
	CONSTRAINT "alert_buyer_profile_known" CHECK ("app"."alert"."buyer_profile" IN ('company', 'private'))
);
--> statement-breakpoint
CREATE TABLE "app"."alert_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"alert_id" uuid NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"hold_reason" text,
	"attempt" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"last_error_code" text,
	"smtp_message_id" text,
	"sent_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_delivery_alert_recipient_unique" UNIQUE("alert_id","recipient"),
	CONSTRAINT "alert_delivery_channel_known" CHECK ("app"."alert_delivery"."channel" IN ('email')),
	CONSTRAINT "alert_delivery_status_known" CHECK ("app"."alert_delivery"."status" IN ('pending', 'sending', 'sent', 'failed', 'expired')),
	CONSTRAINT "alert_delivery_hold_reason_known" CHECK ("app"."alert_delivery"."hold_reason" IS NULL OR "app"."alert_delivery"."hold_reason" IN ('smtp_not_configured', 'smtp_paused', 'rate_limit')),
	CONSTRAINT "alert_delivery_attempt_range" CHECK ("app"."alert_delivery"."attempt" BETWEEN 0 AND 5),
	CONSTRAINT "alert_delivery_sent_at" CHECK (("app"."alert_delivery"."status" = 'sent') = ("app"."alert_delivery"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."audit_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_event_actor_format" CHECK ("app"."audit_event"."actor" ~ '^[a-z]+:[a-z_-]{1,40}$'),
	CONSTRAINT "audit_event_action_format" CHECK ("app"."audit_event"."action" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "app"."candidate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_key" text NOT NULL,
	"listing_id" uuid NOT NULL,
	"feed_id" text NOT NULL,
	"segment" text NOT NULL,
	"source" text NOT NULL,
	"price_cents" integer,
	"shipping_cents" integer,
	"landed_cents" integer,
	"shipping_known" boolean NOT NULL,
	"total_gb" integer,
	"rule_version" integer NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"code_signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"enrich_started_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_item_key_unique" UNIQUE("item_key"),
	CONSTRAINT "candidate_listing_id_unique" UNIQUE("listing_id"),
	CONSTRAINT "candidate_source_known" CHECK ("app"."candidate"."source" IN ('poll', 'sweep')),
	CONSTRAINT "candidate_decision_known" CHECK ("app"."candidate"."decision" IN ('pending', 'alerted', 'blocked', 'rejected_after_enrich', 'gone', 'expired')),
	CONSTRAINT "candidate_reject_reason_format" CHECK ("app"."candidate"."reject_reason" IS NULL OR "app"."candidate"."reject_reason" ~ '^[a-z][a-z0-9_]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "app"."feed" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"category_id" text NOT NULL,
	"q" text NOT NULL,
	"price_ceiling_cents" integer NOT NULL,
	"condition_ids" text[] NOT NULL,
	"day_interval_s" integer NOT NULL,
	"night_interval_s" integer NOT NULL,
	"overflow_pages_per_day" integer DEFAULT 20 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_id_known" CHECK ("app"."feed"."id" IN ('gpu', 'ram', 'pc')),
	CONSTRAINT "feed_category_id_format" CHECK ("app"."feed"."category_id" ~ '^[0-9]{1,12}$'),
	CONSTRAINT "feed_price_ceiling_positive" CHECK ("app"."feed"."price_ceiling_cents" > 0),
	CONSTRAINT "feed_intervals" CHECK ("app"."feed"."day_interval_s" >= 60 AND "app"."feed"."night_interval_s" >= 60),
	CONSTRAINT "feed_overflow_pages" CHECK ("app"."feed"."overflow_pages_per_day" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."llm_usage_daily" (
	"day_berlin" date PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"reserved_microusd" bigint DEFAULT 0 NOT NULL,
	"spent_microusd" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "llm_usage_daily_counts" CHECK ("app"."llm_usage_daily"."calls" >= 0 AND "app"."llm_usage_daily"."reserved_microusd" >= 0 AND "app"."llm_usage_daily"."spent_microusd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."poll_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"feed_id" text NOT NULL,
	"segment" text,
	"kind" text NOT NULL,
	"baseline" boolean DEFAULT false NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"malformed" integer DEFAULT 0 NOT NULL,
	"new_items" integer DEFAULT 0 NOT NULL,
	"candidates" integer DEFAULT 0 NOT NULL,
	"cap_reached" boolean DEFAULT false NOT NULL,
	"warning_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"error_kind" text,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "poll_run_kind_known" CHECK ("app"."poll_run"."kind" IN ('poll', 'sweep')),
	CONSTRAINT "poll_run_segment_for_sweeps" CHECK (("app"."poll_run"."kind" = 'sweep') = ("app"."poll_run"."segment" IS NOT NULL)),
	CONSTRAINT "poll_run_status_known" CHECK ("app"."poll_run"."status" IN ('running', 'ok', 'error', 'quota_refused', 'paused')),
	CONSTRAINT "poll_run_finished_unless_running" CHECK (("app"."poll_run"."status" = 'running') = ("app"."poll_run"."finished_at" IS NULL)),
	CONSTRAINT "poll_run_error_kind_known" CHECK ("app"."poll_run"."error_kind" IS NULL OR "app"."poll_run"."error_kind" IN ('timeout', 'network', 'http_5xx', 'invalid_response', 'deadline', 'db')),
	CONSTRAINT "poll_run_counts" CHECK ("app"."poll_run"."pages" >= 0 AND "app"."poll_run"."items" >= 0 AND "app"."poll_run"."malformed" >= 0 AND "app"."poll_run"."new_items" >= 0 AND "app"."poll_run"."candidates" >= 0 AND "app"."poll_run"."calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."price_sample" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"segment" text NOT NULL,
	"feed_id" text NOT NULL,
	"price_cents" integer NOT NULL,
	"shipping_cents" integer,
	"landed_cents" integer,
	"total_gb" integer,
	"seen_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."purge_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"status" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "purge_run_status_known" CHECK ("app"."purge_run"."status" IN ('ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "app"."screening" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_key" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"verdict" text,
	"product_match" text,
	"risk_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"code_signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"failure_code" text,
	"request_bytes" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_microusd" integer,
	"reserved_microusd" integer,
	"latency_ms" integer,
	"inference_geo" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screening_item_key_prompt_version_unique" UNIQUE("item_key","prompt_version"),
	CONSTRAINT "screening_status_known" CHECK ("app"."screening"."status" IN ('running', 'done', 'failed', 'skipped')),
	CONSTRAINT "screening_attempt_range" CHECK ("app"."screening"."attempt" BETWEEN 1 AND 2),
	CONSTRAINT "screening_verdict_known" CHECK ("app"."screening"."verdict" IS NULL OR "app"."screening"."verdict" IN ('pass', 'caution', 'block')),
	CONSTRAINT "screening_product_match_known" CHECK ("app"."screening"."product_match" IS NULL OR "app"."screening"."product_match" IN ('match', 'mismatch', 'unclear')),
	CONSTRAINT "screening_failure_code_format" CHECK ("app"."screening"."failure_code" IS NULL OR "app"."screening"."failure_code" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "screening_done_has_verdict" CHECK ("app"."screening"."status" <> 'done' OR "app"."screening"."verdict" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "app"."screening_pause" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"until" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "screening_pause_single_row" CHECK ("app"."screening_pause"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "app"."seen_item" (
	"item_key" text PRIMARY KEY NOT NULL,
	"key_version" smallint NOT NULL,
	"feed_id" text NOT NULL,
	"segment" text,
	"first_seen_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"candidate_at" timestamp (3) with time zone,
	"outcome" text NOT NULL,
	CONSTRAINT "seen_item_item_key_format" CHECK ("app"."seen_item"."item_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "seen_item_outcome_format" CHECK ("app"."seen_item"."outcome" ~ '^[a-z][a-z0-9_]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "app"."segment_rule" (
	"segment" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"rule_kind" text NOT NULL,
	"max_landed_cents" integer,
	"floor_cents" integer,
	"max_cents_per_gb" integer,
	"min_cents_per_gb" integer,
	"min_total_gb" integer,
	"sweep_q" text NOT NULL,
	"candidate_cap_per_day" integer DEFAULT 150 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_rule_segment_known" CHECK ("app"."segment_rule"."segment" IN ('gpu_3090', 'gpu_3090ti', 'gpu_4090', 'ram_ddr4', 'ram_ddr5', 'pc_4090')),
	CONSTRAINT "segment_rule_kind_known" CHECK ("app"."segment_rule"."rule_kind" IN ('per_item', 'per_gb')),
	CONSTRAINT "segment_rule_per_item_fields" CHECK ("app"."segment_rule"."rule_kind" <> 'per_item' OR ("app"."segment_rule"."max_landed_cents" IS NOT NULL AND "app"."segment_rule"."floor_cents" IS NOT NULL AND "app"."segment_rule"."floor_cents" > 0 AND "app"."segment_rule"."floor_cents" <= "app"."segment_rule"."max_landed_cents")),
	CONSTRAINT "segment_rule_per_gb_fields" CHECK ("app"."segment_rule"."rule_kind" <> 'per_gb' OR ("app"."segment_rule"."max_cents_per_gb" IS NOT NULL AND "app"."segment_rule"."min_cents_per_gb" IS NOT NULL AND "app"."segment_rule"."min_total_gb" IS NOT NULL AND "app"."segment_rule"."min_cents_per_gb" > 0 AND "app"."segment_rule"."min_cents_per_gb" <= "app"."segment_rule"."max_cents_per_gb" AND "app"."segment_rule"."min_total_gb" > 0)),
	CONSTRAINT "segment_rule_cap" CHECK ("app"."segment_rule"."candidate_cap_per_day" >= 0),
	CONSTRAINT "segment_rule_version_positive" CHECK ("app"."segment_rule"."rule_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."smtp_pause" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"until" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "smtp_pause_single_row" CHECK ("app"."smtp_pause"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "app"."worker_status" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"git_sha" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"heartbeat_at" timestamp (3) with time zone NOT NULL,
	"smtp_configured" boolean NOT NULL,
	"claude_configured" boolean NOT NULL,
	CONSTRAINT "worker_status_single_row" CHECK ("app"."worker_status"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ebay_live"."alert_message" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ebay_live"."classifier_sample" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"feed_id" text NOT NULL,
	"segment" text,
	"title" text NOT NULL,
	"landed_cents" integer,
	"outcome" text NOT NULL,
	"reason" text,
	"seen_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "classifier_sample_outcome_known" CHECK ("ebay_live"."classifier_sample"."outcome" IN ('candidate', 'rejected')),
	CONSTRAINT "classifier_sample_reason_for_rejections" CHECK (("ebay_live"."classifier_sample"."outcome" = 'rejected') = ("ebay_live"."classifier_sample"."reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ebay_live"."listing" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_key" text NOT NULL,
	"key_version" smallint NOT NULL,
	"item_id" text NOT NULL,
	"legacy_item_id" text NOT NULL,
	"feed_id" text NOT NULL,
	"segment" text NOT NULL,
	"first_seen_at" timestamp (3) with time zone NOT NULL,
	"last_confirmed_at" timestamp (3) with time zone NOT NULL,
	"item_creation_at" timestamp (3) with time zone,
	"item_end_at" timestamp (3) with time zone,
	"content_expires_at" timestamp (3) with time zone NOT NULL,
	"gone_at" timestamp (3) with time zone,
	"gone_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_item_key_unique" UNIQUE("item_key"),
	CONSTRAINT "listing_legacy_item_id_format" CHECK ("ebay_live"."listing"."legacy_item_id" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "listing_gone_reason_known" CHECK (("ebay_live"."listing"."gone_at" IS NULL) = ("ebay_live"."listing"."gone_reason" IS NULL) AND ("ebay_live"."listing"."gone_reason" IS NULL OR "ebay_live"."listing"."gone_reason" IN ('ended', 'unconfirmed', 'not_found')))
);
--> statement-breakpoint
CREATE TABLE "ebay_live"."listing_content" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"condition" text,
	"condition_description" text,
	"seller_feedback_score" integer,
	"seller_feedback_pct" double precision,
	"seller_account_type" text,
	"returns_accepted" boolean,
	"returns_days" integer,
	"item_location_country" text,
	"aspects" jsonb,
	"description_text" text,
	"image_count" integer,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	"content_expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "listing_content_source_known" CHECK ("ebay_live"."listing_content"."source" IN ('summary', 'item')),
	CONSTRAINT "listing_content_seller_account_type_known" CHECK ("ebay_live"."listing_content"."seller_account_type" IS NULL OR "ebay_live"."listing_content"."seller_account_type" IN ('business', 'private'))
);
--> statement-breakpoint
CREATE TABLE "ebay_live"."screening_text" (
	"screening_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."segment_rule" ADD CONSTRAINT "segment_rule_feed_id_feed_id_fk" FOREIGN KEY ("feed_id") REFERENCES "app"."feed"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ebay_live"."listing_content" ADD CONSTRAINT "listing_content_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "ebay_live"."listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_delivery_status_next_attempt_idx" ON "app"."alert_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "candidate_segment_created_idx" ON "app"."candidate" USING btree ("segment","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "poll_run_feed_kind_started_idx" ON "app"."poll_run" USING btree ("feed_id","kind","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "poll_run_segment_kind_started_idx" ON "app"."poll_run" USING btree ("segment","kind","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "price_sample_segment_seen_at_idx" ON "app"."price_sample" USING btree ("segment","seen_at");--> statement-breakpoint
CREATE INDEX "seen_item_feed_id_idx" ON "app"."seen_item" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "alert_message_expires_at_idx" ON "ebay_live"."alert_message" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "classifier_sample_expires_at_idx" ON "ebay_live"."classifier_sample" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "classifier_sample_feed_seen_at_idx" ON "ebay_live"."classifier_sample" USING btree ("feed_id","seen_at");--> statement-breakpoint
CREATE INDEX "listing_content_expires_at_idx" ON "ebay_live"."listing" USING btree ("content_expires_at");--> statement-breakpoint
CREATE INDEX "listing_gone_at_idx" ON "ebay_live"."listing" USING btree ("gone_at");--> statement-breakpoint
CREATE INDEX "listing_last_confirmed_at_idx" ON "ebay_live"."listing" USING btree ("last_confirmed_at");--> statement-breakpoint
CREATE INDEX "listing_content_content_expires_at_idx" ON "ebay_live"."listing_content" USING btree ("content_expires_at");--> statement-breakpoint
CREATE INDEX "screening_text_expires_at_idx" ON "ebay_live"."screening_text" USING btree ("expires_at");