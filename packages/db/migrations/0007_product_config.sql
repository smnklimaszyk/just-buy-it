CREATE SEQUENCE "app"."search_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "app"."product" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"category_id" text NOT NULL,
	"category_name" text,
	"condition_ids" text[] NOT NULL,
	"search_words" text[] NOT NULL,
	"must_words" jsonb NOT NULL,
	"exclude_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"warn_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"use_default_junk" boolean DEFAULT true NOT NULL,
	"junk_exceptions" text[] DEFAULT '{}'::text[] NOT NULL,
	"accessory_check" boolean DEFAULT true NOT NULL,
	"per_gb" boolean DEFAULT false NOT NULL,
	"unit_min_total" integer,
	"unit_max_total" integer,
	"price_mode" text NOT NULL,
	"max_cents" integer NOT NULL,
	"below_market_pct" smallint,
	"floor_cents" integer,
	"read_ceiling_cents" integer,
	"speed" text DEFAULT 'normal' NOT NULL,
	"price_drop_check" boolean DEFAULT false NOT NULL,
	"sweep_minute" smallint NOT NULL,
	"candidate_cap_per_day" integer DEFAULT 10 NOT NULL,
	"buyer_profile" text NOT NULL,
	"claude_required" boolean DEFAULT false NOT NULL,
	"alert_recipient_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"match_version" integer DEFAULT 1 NOT NULL,
	"watch_from" timestamp (3) with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_key_unique" UNIQUE("key"),
	CONSTRAINT "product_key_format" CHECK ("app"."product"."key" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "product_name_length" CHECK (char_length("app"."product"."name") BETWEEN 1 AND 60),
	CONSTRAINT "product_description_length" CHECK (char_length("app"."product"."description") BETWEEN 1 AND 300),
	CONSTRAINT "product_no_markup" CHECK (position('<' in "app"."product"."name") = 0 AND position('<' in "app"."product"."description") = 0),
	CONSTRAINT "product_status_known" CHECK ("app"."product"."status" IN ('draft', 'active', 'paused', 'archived')),
	CONSTRAINT "product_category_id_format" CHECK ("app"."product"."category_id" ~ '^[0-9]{1,12}$'),
	CONSTRAINT "product_condition_ids_format" CHECK (cardinality("app"."product"."condition_ids") BETWEEN 1 AND 15 AND array_position("app"."product"."condition_ids", NULL) IS NULL AND array_to_string("app"."product"."condition_ids", ',') ~ '^[0-9]{4}(,[0-9]{4})*$'),
	CONSTRAINT "product_condition_ids_no_parts" CHECK (NOT ('7000' = ANY("app"."product"."condition_ids"))),
	CONSTRAINT "product_list_sizes" CHECK (cardinality("app"."product"."search_words") BETWEEN 1 AND 8 AND cardinality("app"."product"."exclude_words") <= 60 AND cardinality("app"."product"."warn_words") <= 30 AND cardinality("app"."product"."junk_exceptions") <= 20 AND cardinality("app"."product"."alert_recipient_ids") <= 20),
	CONSTRAINT "product_must_words_shape" CHECK (CASE WHEN jsonb_typeof("app"."product"."must_words") = 'array' THEN jsonb_array_length("app"."product"."must_words") BETWEEN 1 AND 6 ELSE false END),
	CONSTRAINT "product_per_gb_units" CHECK (NOT "app"."product"."per_gb" OR ("app"."product"."unit_min_total" IS NOT NULL AND "app"."product"."unit_max_total" IS NOT NULL AND "app"."product"."unit_min_total" > 0 AND "app"."product"."unit_max_total" >= "app"."product"."unit_min_total")),
	CONSTRAINT "product_price_mode_known" CHECK ("app"."product"."price_mode" IN ('fixed', 'below_market')),
	CONSTRAINT "product_below_market_pct" CHECK (("app"."product"."price_mode" = 'below_market') = ("app"."product"."below_market_pct" IS NOT NULL) AND ("app"."product"."below_market_pct" IS NULL OR "app"."product"."below_market_pct" BETWEEN 1 AND 90)),
	CONSTRAINT "product_max_positive" CHECK ("app"."product"."max_cents" > 0),
	CONSTRAINT "product_floor_range" CHECK ("app"."product"."floor_cents" IS NULL OR ("app"."product"."floor_cents" > 0 AND "app"."product"."floor_cents" <= "app"."product"."max_cents")),
	CONSTRAINT "product_read_ceiling_positive" CHECK ("app"."product"."read_ceiling_cents" IS NULL OR "app"."product"."read_ceiling_cents" > 0),
	CONSTRAINT "product_speed_known" CHECK ("app"."product"."speed" IN ('fast', 'normal', 'slow')),
	CONSTRAINT "product_sweep_minute_range" CHECK ("app"."product"."sweep_minute" BETWEEN 0 AND 59),
	CONSTRAINT "product_candidate_cap_range" CHECK ("app"."product"."candidate_cap_per_day" BETWEEN 0 AND 200),
	CONSTRAINT "product_buyer_profile_known" CHECK ("app"."product"."buyer_profile" IN ('company', 'private')),
	CONSTRAINT "product_versions_positive" CHECK ("app"."product"."version" >= 1 AND "app"."product"."match_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."product_revision" (
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_revision_product_id_version_pk" PRIMARY KEY("product_id","version"),
	CONSTRAINT "product_revision_version_positive" CHECK ("app"."product_revision"."version" >= 1),
	CONSTRAINT "product_revision_actor_format" CHECK ("app"."product_revision"."actor" ~ '^[a-z]+:[a-z0-9_-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "app"."product_source" (
	"product_id" uuid NOT NULL,
	"source" text NOT NULL,
	"enabled" boolean NOT NULL,
	"ka_saved_search_id" text,
	"ka_price_limit_cents" integer,
	CONSTRAINT "product_source_product_id_source_pk" PRIMARY KEY("product_id","source"),
	CONSTRAINT "product_source_source_known" CHECK ("app"."product_source"."source" IN ('ebay', 'kleinanzeigen')),
	CONSTRAINT "product_source_ka_fields" CHECK (("app"."product_source"."source" = 'kleinanzeigen' OR ("app"."product_source"."ka_saved_search_id" IS NULL AND "app"."product_source"."ka_price_limit_cents" IS NULL)) AND ("app"."product_source"."ka_price_limit_cents" IS NULL OR "app"."product_source"."ka_price_limit_cents" > 0))
);
--> statement-breakpoint
CREATE TABLE "app"."search" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"condition_ids" text[] NOT NULL,
	"q" text NOT NULL,
	"floor_eur" integer NOT NULL,
	"ceiling_eur" integer NOT NULL,
	"day_interval_s" integer NOT NULL,
	"night_interval_s" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"retired_at" timestamp (3) with time zone,
	"members_hash" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_id_format" CHECK ("app"."search"."id" ~ '^s[1-9][0-9]{0,17}$'),
	CONSTRAINT "search_category_id_format" CHECK ("app"."search"."category_id" ~ '^[0-9]{1,12}$'),
	CONSTRAINT "search_condition_ids_format" CHECK (cardinality("app"."search"."condition_ids") BETWEEN 1 AND 15 AND array_position("app"."search"."condition_ids", NULL) IS NULL AND array_to_string("app"."search"."condition_ids", ',') ~ '^[0-9]{4}(,[0-9]{4})*$'),
	CONSTRAINT "search_intervals" CHECK ("app"."search"."day_interval_s" >= 60 AND "app"."search"."night_interval_s" >= 60),
	CONSTRAINT "search_price_range" CHECK ("app"."search"."floor_eur" >= 0 AND "app"."search"."ceiling_eur" >= "app"."search"."floor_eur")
);
--> statement-breakpoint
CREATE TABLE "app"."search_product" (
	"search_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "search_product_search_id_product_id_pk" PRIMARY KEY("search_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "app"."setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_key_format" CHECK ("app"."setting"."key" ~ '^[a-z][a-z0-9_]{0,30}\.[a-z][a-z0-9_]{0,40}$'),
	CONSTRAINT "setting_version_positive" CHECK ("app"."setting"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."product_revision" ADD CONSTRAINT "product_revision_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_source" ADD CONSTRAINT "product_source_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."search_product" ADD CONSTRAINT "search_product_search_id_search_id_fk" FOREIGN KEY ("search_id") REFERENCES "app"."search"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."search_product" ADD CONSTRAINT "search_product_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;