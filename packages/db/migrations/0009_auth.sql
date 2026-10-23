-- auth.app_user.email is citext. drizzle-kit does not write CREATE EXTENSION, so it lives here.
-- citext is a trusted extension: the database owner may create it.
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
--> statement-breakpoint
CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TABLE "auth"."app_user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" "citext" NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"disabled_at" timestamp (3) with time zone,
	CONSTRAINT "app_user_email_unique" UNIQUE("email"),
	CONSTRAINT "app_user_email_format" CHECK (char_length("auth"."app_user"."email") <= 254 AND "auth"."app_user"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "app_user_role_known" CHECK ("auth"."app_user"."role" IN ('admin', 'editor')),
	CONSTRAINT "app_user_status_known" CHECK ("auth"."app_user"."status" IN ('active', 'disabled')),
	CONSTRAINT "app_user_disabled_at" CHECK (("auth"."app_user"."status" = 'disabled') = ("auth"."app_user"."disabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "auth"."auth_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	"event" text NOT NULL,
	"user_id" uuid,
	"email_mac" text,
	"ip" "inet",
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "auth_event_event_known" CHECK ("auth"."auth_event"."event" IN ('login_code_requested', 'login_code_capped', 'login_succeeded', 'login_failed', 'login_locked', 'login_mail_failed', 'session_ended', 'sign_out_everywhere', 'login_code_cli', 'device_revoked'))
);
--> statement-breakpoint
CREATE TABLE "auth"."device" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "device_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "auth"."login_attempt" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ref" char(4) NOT NULL,
	"attempt_hash" text NOT NULL,
	"user_id" uuid,
	"device_id" uuid,
	"email_mac" text NOT NULL,
	"code_mac" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"failed_tries" smallint DEFAULT 0 NOT NULL,
	"used_at" timestamp (3) with time zone,
	"closed_at" timestamp (3) with time zone,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "login_attempt_attempt_hash_unique" UNIQUE("attempt_hash"),
	CONSTRAINT "login_attempt_ref_format" CHECK ("auth"."login_attempt"."ref" ~ '^[ACDEFHJKMNPQRTUVWXY34679]{4}$'),
	CONSTRAINT "login_attempt_failed_tries_range" CHECK ("auth"."login_attempt"."failed_tries" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "auth"."rate_counter" (
	"key" text NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_counter_key_window_start_pk" PRIMARY KEY("key","window_start"),
	CONSTRAINT "rate_counter_key_length" CHECK (char_length("auth"."rate_counter"."key") BETWEEN 1 AND 200),
	CONSTRAINT "rate_counter_count" CHECK ("auth"."rate_counter"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_secret" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"end_reason" text,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "session_ended_reason" CHECK (("auth"."session"."ended_at" IS NULL) = ("auth"."session"."end_reason" IS NULL) AND ("auth"."session"."end_reason" IS NULL OR "auth"."session"."end_reason" ~ '^[a-z][a-z0-9_]{0,39}$'))
);
--> statement-breakpoint
ALTER TABLE "auth"."device" ADD CONSTRAINT "device_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."login_attempt" ADD CONSTRAINT "login_attempt_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."login_attempt" ADD CONSTRAINT "login_attempt_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "auth"."device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_event_at_idx" ON "auth"."auth_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "device_user_id_idx" ON "auth"."device" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_attempt_email_mac_created_idx" ON "auth"."login_attempt" USING btree ("email_mac","created_at");--> statement-breakpoint
CREATE INDEX "login_attempt_ref_created_idx" ON "auth"."login_attempt" USING btree ("ref","created_at");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" USING btree ("user_id");