CREATE TABLE "game_analytics" (
	"game_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"totals" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rating_snapshots" ADD COLUMN "view" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "game_analytics" ADD CONSTRAINT "game_analytics_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;