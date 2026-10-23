CREATE TABLE "app"."llm_usage_product_daily" (
	"day_berlin" date NOT NULL,
	"product_key" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "llm_usage_product_daily_day_berlin_product_key_pk" PRIMARY KEY("day_berlin","product_key"),
	CONSTRAINT "llm_usage_product_daily_calls" CHECK ("app"."llm_usage_product_daily"."calls" >= 0)
);
--> statement-breakpoint
-- Spec 2.9: two checks replaced by wider ones under the same name, each in one statement (the
-- looser form ADR 0005 allows outside a contract file). Every row valid before stays valid.
ALTER TABLE "app"."audit_event" DROP CONSTRAINT "audit_event_actor_format", ADD CONSTRAINT "audit_event_actor_format" CHECK ("app"."audit_event"."actor" ~ '^[a-z]+:[a-z0-9_-]{1,40}$');--> statement-breakpoint
ALTER TABLE "app"."candidate" DROP CONSTRAINT "candidate_decision_known", ADD CONSTRAINT "candidate_decision_known" CHECK ("app"."candidate"."decision" IN ('pending', 'alerted', 'blocked', 'rejected_after_enrich', 'gone', 'expired', 'wrong_product', 'held'));--> statement-breakpoint
-- Spec 2.8: nullable, so Release 0 keeps writing candidates on this schema.
ALTER TABLE "app"."candidate" ADD COLUMN "product_version" integer;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "match_version" integer;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "condition_group" text;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "limit_cents" integer;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "price_mode" text;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "market_value_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD COLUMN "held_reason" text;--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD CONSTRAINT "candidate_price_mode_known" CHECK ("app"."candidate"."price_mode" IS NULL OR "app"."candidate"."price_mode" IN ('fixed', 'below_market'));--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD CONSTRAINT "candidate_condition_group_known" CHECK ("app"."candidate"."condition_group" IS NULL OR "app"."candidate"."condition_group" IN ('new', 'open_box', 'refurbished', 'used'));--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD CONSTRAINT "candidate_held_reason_format" CHECK ("app"."candidate"."held_reason" IS NULL OR "app"."candidate"."held_reason" ~ '^[a-z][a-z0-9_]{0,39}$');--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD CONSTRAINT "candidate_versions_positive" CHECK (("app"."candidate"."product_version" IS NULL OR "app"."candidate"."product_version" >= 1) AND ("app"."candidate"."match_version" IS NULL OR "app"."candidate"."match_version" >= 1));--> statement-breakpoint
ALTER TABLE "app"."candidate" ADD CONSTRAINT "candidate_limit_positive" CHECK ("app"."candidate"."limit_cents" IS NULL OR "app"."candidate"."limit_cents" > 0);
