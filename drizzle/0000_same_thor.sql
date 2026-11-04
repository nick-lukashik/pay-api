CREATE TABLE "inbox" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"exchange" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_key" text NOT NULL,
	"grm" bigint NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text,
	"checkout_url" text,
	"status" text DEFAULT 'created' NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"failure_reason" text,
	"paid_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_grm_positive" CHECK ("payments"."grm" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"outcome" text NOT NULL,
	"payment_id" uuid,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at","created_at") WHERE "outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_published_idx" ON "outbox" USING btree ("published_at") WHERE "outbox"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_user_key_uq" ON "payments" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_id_uq" ON "payments" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe_uq" ON "webhook_events" USING btree ("provider","dedupe_key");