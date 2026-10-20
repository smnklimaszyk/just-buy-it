CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TABLE "app"."api_usage_hourly" (
	"hour_utc" timestamp (3) with time zone NOT NULL,
	"resource" text NOT NULL,
	"purpose" text NOT NULL,
	"calls" integer NOT NULL,
	CONSTRAINT "api_usage_hourly_hour_utc_resource_purpose_pk" PRIMARY KEY("hour_utc","resource","purpose"),
	CONSTRAINT "api_usage_hourly_purpose_format" CHECK ("app"."api_usage_hourly"."purpose" ~ '^[a-z][a-z0-9_-]{0,39}$'),
	CONSTRAINT "api_usage_hourly_calls_positive" CHECK ("app"."api_usage_hourly"."calls" > 0),
	CONSTRAINT "api_usage_hourly_whole_hour" CHECK (extract(epoch FROM "app"."api_usage_hourly"."hour_utc")::bigint % 3600 = 0)
);
--> statement-breakpoint
CREATE TABLE "app"."deletion_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"notification_id" text NOT NULL,
	"topic" text NOT NULL,
	"event_date" timestamp (3) with time zone NOT NULL,
	"publish_attempt_count" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_event_notification_id_unique" UNIQUE("notification_id"),
	CONSTRAINT "deletion_event_notification_id_length" CHECK (char_length("app"."deletion_event"."notification_id") BETWEEN 1 AND 128),
	CONSTRAINT "deletion_event_topic_length" CHECK (char_length("app"."deletion_event"."topic") BETWEEN 1 AND 64),
	CONSTRAINT "deletion_event_publish_attempt_count" CHECK ("app"."deletion_event"."publish_attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."deletion_result_hourly" (
	"hour_utc" timestamp (3) with time zone NOT NULL,
	"result" text NOT NULL,
	"notifications" integer NOT NULL,
	CONSTRAINT "deletion_result_hourly_hour_utc_result_pk" PRIMARY KEY("hour_utc","result"),
	CONSTRAINT "deletion_result_hourly_result_format" CHECK ("app"."deletion_result_hourly"."result" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "deletion_result_hourly_notifications_positive" CHECK ("app"."deletion_result_hourly"."notifications" > 0),
	CONSTRAINT "deletion_result_hourly_whole_hour" CHECK (extract(epoch FROM "app"."deletion_result_hourly"."hour_utc")::bigint % 3600 = 0)
);
--> statement-breakpoint
CREATE TABLE "app"."ebay_quota_window" (
	"resource" text NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"window_end" timestamp (3) with time zone NOT NULL,
	"limit_total" integer DEFAULT 5000 NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"used_alert_path" integer DEFAULT 0 NOT NULL,
	"used_standard" integer DEFAULT 0 NOT NULL,
	"ebay_offset" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ebay_quota_window_resource_window_start_pk" PRIMARY KEY("resource","window_start"),
	CONSTRAINT "ebay_quota_window_resource_format" CHECK ("app"."ebay_quota_window"."resource" ~ '^[a-z]+\.[a-z_.]+$'),
	CONSTRAINT "ebay_quota_window_bounds" CHECK ("app"."ebay_quota_window"."window_end" > "app"."ebay_quota_window"."window_start"),
	CONSTRAINT "ebay_quota_window_counts" CHECK ("app"."ebay_quota_window"."limit_total" > 0 AND "app"."ebay_quota_window"."used" >= 0 AND "app"."ebay_quota_window"."ebay_offset" >= 0),
	CONSTRAINT "ebay_quota_window_used_sum" CHECK ("app"."ebay_quota_window"."used" = "app"."ebay_quota_window"."used_alert_path" + "app"."ebay_quota_window"."used_standard")
);
