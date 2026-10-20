CREATE TABLE "app"."probe_seen" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"seen_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "probe_seen_single_row" CHECK ("app"."probe_seen"."id" = 1)
);
