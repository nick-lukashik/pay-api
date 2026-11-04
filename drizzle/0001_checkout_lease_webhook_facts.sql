ALTER TABLE "payments" ADD COLUMN "checkout_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "checkout_lease_until" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "provider_payment_id" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "payment_status" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "applied_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "webhook_events_unmatched_idx" ON "webhook_events" USING btree ("provider","provider_payment_id") WHERE "webhook_events"."outcome" = 'unmatched';