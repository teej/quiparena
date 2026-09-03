CREATE TYPE "public"."game_status" AS ENUM('created', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."rating_population" AS ENUM('player', 'audience', 'blended');--> statement-breakpoint
CREATE TYPE "public"."trace_kind" AS ENUM('answer', 'final', 'vote');--> statement-breakpoint
CREATE TYPE "public"."vote_population" AS ENUM('player', 'audience');--> statement-breakpoint
CREATE TYPE "public"."vote_source" AS ENUM('game', 'twitch', 'web', 'model');--> statement-breakpoint
CREATE TABLE "answers" (
	"id" text PRIMARY KEY NOT NULL,
	"matchup_id" text,
	"thriplash_id" text,
	"game_id" text NOT NULL,
	"player_id" text NOT NULL,
	"answer_index" integer NOT NULL,
	"text" text NOT NULL,
	"blank" boolean DEFAULT false NOT NULL,
	"lines" jsonb,
	"latency_ms" integer,
	CONSTRAINT "answers_one_target_check" CHECK (("answers"."matchup_id" is not null and "answers"."thriplash_id" is null) or ("answers"."matchup_id" is null and "answers"."thriplash_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"game_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"event_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_players" (
	"game_id" text NOT NULL,
	"player_id" text NOT NULL,
	"name" varchar(12) NOT NULL,
	"model_slug" text,
	"seat" integer,
	"vip" boolean DEFAULT false NOT NULL,
	"placement" integer,
	"total_score" integer,
	CONSTRAINT "game_players_game_id_player_id_pk" PRIMARY KEY("game_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"room_code" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" "game_status" DEFAULT 'created' NOT NULL,
	"final_scores" jsonb
);
--> statement-breakpoint
CREATE TABLE "matchups" (
	"id" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"round" integer NOT NULL,
	"index" integer NOT NULL,
	"prompt" text NOT NULL,
	"scores" jsonb,
	CONSTRAINT "matchups_round_check" CHECK ("matchups"."round" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "models" (
	"slug" text PRIMARY KEY NOT NULL,
	"display_name" varchar(12) NOT NULL,
	"lab" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"population" "rating_population" NOT NULL,
	"method" text NOT NULL,
	"results" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thriplashes" (
	"id" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"prompt" text NOT NULL,
	"scores" jsonb
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"player_id" text NOT NULL,
	"prompt" text NOT NULL,
	"kind" "trace_kind" NOT NULL,
	"reasoning" text NOT NULL,
	"answer" text NOT NULL,
	"usage" jsonb,
	"cost_usd" numeric,
	"model_slug" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"matchup_id" text,
	"thriplash_id" text,
	"voter_id" text,
	"population" "vote_population" NOT NULL,
	"source" "vote_source" NOT NULL,
	"choice" integer NOT NULL,
	"weight" numeric DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_one_target_check" CHECK (("votes"."matchup_id" is not null and "votes"."thriplash_id" is null) or ("votes"."matchup_id" is null and "votes"."thriplash_id" is not null)),
	CONSTRAINT "votes_choice_check" CHECK ("votes"."choice" >= 0),
	CONSTRAINT "votes_weight_check" CHECK ("votes"."weight" > 0)
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_matchup_id_matchups_id_fk" FOREIGN KEY ("matchup_id") REFERENCES "public"."matchups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_thriplash_id_thriplashes_id_fk" FOREIGN KEY ("thriplash_id") REFERENCES "public"."thriplashes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_model_slug_models_slug_fk" FOREIGN KEY ("model_slug") REFERENCES "public"."models"("slug") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thriplashes" ADD CONSTRAINT "thriplashes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_model_slug_models_slug_fk" FOREIGN KEY ("model_slug") REFERENCES "public"."models"("slug") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_matchup_id_matchups_id_fk" FOREIGN KEY ("matchup_id") REFERENCES "public"."matchups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_thriplash_id_thriplashes_id_fk" FOREIGN KEY ("thriplash_id") REFERENCES "public"."thriplashes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answers_matchup_index_uidx" ON "answers" USING btree ("matchup_id","answer_index");--> statement-breakpoint
CREATE UNIQUE INDEX "answers_matchup_player_uidx" ON "answers" USING btree ("matchup_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "answers_thriplash_index_uidx" ON "answers" USING btree ("thriplash_id","answer_index");--> statement-breakpoint
CREATE UNIQUE INDEX "answers_thriplash_player_uidx" ON "answers" USING btree ("thriplash_id","player_id");--> statement-breakpoint
CREATE INDEX "answers_game_player_idx" ON "answers" USING btree ("game_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_event_key_uidx" ON "events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "events_game_id_idx" ON "events" USING btree ("game_id","id");--> statement-breakpoint
CREATE INDEX "events_type_at_idx" ON "events" USING btree ("type","at");--> statement-breakpoint
CREATE UNIQUE INDEX "game_players_game_seat_uidx" ON "game_players" USING btree ("game_id","seat");--> statement-breakpoint
CREATE INDEX "game_players_model_game_idx" ON "game_players" USING btree ("model_slug","game_id");--> statement-breakpoint
CREATE INDEX "game_players_game_placement_idx" ON "game_players" USING btree ("game_id","placement");--> statement-breakpoint
CREATE INDEX "games_status_started_idx" ON "games" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "games_started_idx" ON "games" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "games_room_started_idx" ON "games" USING btree ("room_code","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matchups_game_round_index_uidx" ON "matchups" USING btree ("game_id","round","index");--> statement-breakpoint
CREATE INDEX "matchups_game_idx" ON "matchups" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "matchups_prompt_idx" ON "matchups" USING btree ("prompt");--> statement-breakpoint
CREATE INDEX "models_enabled_idx" ON "models" USING btree ("enabled","slug");--> statement-breakpoint
CREATE INDEX "models_lab_idx" ON "models" USING btree ("lab");--> statement-breakpoint
CREATE INDEX "rating_snapshots_population_computed_idx" ON "rating_snapshots" USING btree ("population","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thriplashes_game_uidx" ON "thriplashes" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "traces_game_created_idx" ON "traces" USING btree ("game_id","created_at");--> statement-breakpoint
CREATE INDEX "traces_game_player_created_idx" ON "traces" USING btree ("game_id","player_id","created_at");--> statement-breakpoint
CREATE INDEX "traces_model_created_idx" ON "traces" USING btree ("model_slug","created_at");--> statement-breakpoint
CREATE INDEX "votes_game_population_idx" ON "votes" USING btree ("game_id","population");--> statement-breakpoint
CREATE INDEX "votes_matchup_population_idx" ON "votes" USING btree ("matchup_id","population");--> statement-breakpoint
CREATE INDEX "votes_thriplash_population_idx" ON "votes" USING btree ("thriplash_id","population");--> statement-breakpoint
CREATE INDEX "votes_created_idx" ON "votes" USING btree ("created_at");