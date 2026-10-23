CREATE TABLE "ebay_live"."market_preview" (
	"product_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"legacy_item_id" text NOT NULL,
	"title" text NOT NULL,
	"landed_cents" integer,
	"condition_group" text,
	"outcome" text NOT NULL,
	"seen_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "market_preview_product_id_item_key_pk" PRIMARY KEY("product_id","item_key"),
	CONSTRAINT "market_preview_legacy_item_id_format" CHECK ("ebay_live"."market_preview"."legacy_item_id" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "market_preview_outcome_format" CHECK ("ebay_live"."market_preview"."outcome" ~ '^[a-z][a-z0-9_]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "app"."category_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"requested_by" uuid,
	"q" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"result" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp (3) with time zone,
	CONSTRAINT "category_request_q_length" CHECK (char_length("app"."category_request"."q") BETWEEN 1 AND 200),
	CONSTRAINT "category_request_status_known" CHECK ("app"."category_request"."status" IN ('open', 'queued', 'running', 'done', 'refused')),
	CONSTRAINT "category_request_done_at" CHECK (("app"."category_request"."status" IN ('done', 'refused')) = ("app"."category_request"."done_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."market_daily" (
	"day_berlin" date PRIMARY KEY NOT NULL,
	"extra_snapshots" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "market_daily_extra_snapshots" CHECK ("app"."market_daily"."extra_snapshots" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."market_listing" (
	"product_id" uuid NOT NULL,
	"match_version" integer NOT NULL,
	"source" text NOT NULL,
	"item_key" text NOT NULL,
	"condition_group" text,
	"landed_cents" integer NOT NULL,
	"unit_total" integer,
	"origin_at" timestamp (3) with time zone,
	"first_seen_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"best_offer" boolean NOT NULL,
	"excluded_reason" text,
	CONSTRAINT "market_listing_product_id_source_item_key_pk" PRIMARY KEY("product_id","source","item_key"),
	CONSTRAINT "market_listing_item_key_format" CHECK ("app"."market_listing"."item_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "market_listing_source_known" CHECK ("app"."market_listing"."source" IN ('ebay', 'kleinanzeigen')),
	CONSTRAINT "market_listing_condition_group_known" CHECK (CASE WHEN "app"."market_listing"."condition_group" IS NULL THEN "app"."market_listing"."excluded_reason" IS NOT NULL ELSE "app"."market_listing"."condition_group" IN ('new', 'open_box', 'refurbished', 'used') END),
	CONSTRAINT "market_listing_excluded_reason_format" CHECK ("app"."market_listing"."excluded_reason" IS NULL OR "app"."market_listing"."excluded_reason" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "market_listing_counts" CHECK ("app"."market_listing"."landed_cents" >= 0 AND "app"."market_listing"."match_version" >= 1 AND ("app"."market_listing"."unit_total" IS NULL OR "app"."market_listing"."unit_total" > 0))
);
--> statement-breakpoint
CREATE TABLE "app"."market_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"product_id" uuid NOT NULL,
	"requested_by" uuid,
	"reason" text NOT NULL,
	"requested_at" timestamp (3) with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"done_at" timestamp (3) with time zone,
	CONSTRAINT "market_request_reason_known" CHECK ("app"."market_request"."reason" IN ('created', 'rules_changed', 'check_now')),
	CONSTRAINT "market_request_status_known" CHECK ("app"."market_request"."status" IN ('open', 'queued', 'running', 'done', 'refused')),
	CONSTRAINT "market_request_done_at" CHECK (("app"."market_request"."status" IN ('done', 'refused')) = ("app"."market_request"."done_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."market_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"product_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"total" integer,
	"error_kind" text,
	CONSTRAINT "market_run_status_known" CHECK ("app"."market_run"."status" IN ('running', 'ok', 'error', 'quota_refused', 'discarded')),
	CONSTRAINT "market_run_finished_unless_running" CHECK (("app"."market_run"."status" = 'running') = ("app"."market_run"."finished_at" IS NULL)),
	CONSTRAINT "market_run_error_kind_format" CHECK ("app"."market_run"."error_kind" IS NULL OR "app"."market_run"."error_kind" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "market_run_counts" CHECK ("app"."market_run"."calls" >= 0 AND "app"."market_run"."pages" >= 0 AND ("app"."market_run"."total" IS NULL OR "app"."market_run"."total" >= 0))
);
--> statement-breakpoint
CREATE TABLE "app"."market_value" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"product_id" uuid NOT NULL,
	"condition_group" text NOT NULL,
	"match_version" integer NOT NULL,
	"computed_at" timestamp (3) with time zone NOT NULL,
	"method_version" text NOT NULL,
	"status" text NOT NULL,
	"capped" boolean NOT NULL,
	"n" integer NOT NULL,
	"neff" numeric NOT NULL,
	"m_cents" integer,
	"p25_cents" integer,
	"p75_cents" integer,
	"lo_cents" integer,
	"hi_cents" integer,
	"half_width" numeric,
	"best_offer_share" numeric,
	"value_cents" integer,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "market_value_condition_group_known" CHECK ("app"."market_value"."condition_group" IN ('new', 'open_box', 'refurbished', 'used')),
	CONSTRAINT "market_value_status_known" CHECK ("app"."market_value"."status" IN ('none', 'rough', 'ok')),
	CONSTRAINT "market_value_counts" CHECK ("app"."market_value"."n" >= 0 AND "app"."market_value"."neff" >= 0 AND "app"."market_value"."match_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."market_listing" ADD CONSTRAINT "market_listing_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."market_request" ADD CONSTRAINT "market_request_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."market_run" ADD CONSTRAINT "market_run_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."market_value" ADD CONSTRAINT "market_value_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_preview_seen_at_idx" ON "ebay_live"."market_preview" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_request_one_open" ON "app"."market_request" USING btree ("product_id") WHERE "app"."market_request"."status" IN ('open', 'queued', 'running');--> statement-breakpoint
CREATE INDEX "market_value_lookup_idx" ON "app"."market_value" USING btree ("product_id","condition_group","match_version","computed_at" DESC NULLS LAST);