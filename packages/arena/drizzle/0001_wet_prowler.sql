ALTER TYPE "public"."game_status" ADD VALUE 'abandoned';--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "observed_scores" jsonb;