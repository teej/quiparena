import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import type { GameEvent } from "@quiparena/core";
import type { ModelBenchState } from "../lobby.js";

export type JsonObject = Record<string, unknown>;
export type ScoreMap = Record<string, number>;
export interface ObservedScore {
  name: string;
  score: number;
  placement?: number;
}

export const gameStatus = pgEnum("game_status", ["created", "running", "completed", "failed", "abandoned"]);
export const votePopulation = pgEnum("vote_population", ["player", "audience"]);
export const voteSource = pgEnum("vote_source", ["game", "twitch", "web", "model"]);
export const traceKind = pgEnum("trace_kind", ["answer", "final", "vote"]);
export const ratingPopulation = pgEnum("rating_population", ["player", "audience", "blended"]);

export const models = pgTable("models", {
  slug: text("slug").primaryKey(),
  displayName: varchar("display_name", { length: 12 }).notNull(),
  lab: text("lab").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  benchState: jsonb("bench_state").$type<ModelBenchState>(),
  config: jsonb("config").$type<JsonObject>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("models_enabled_idx").on(table.enabled, table.slug),
  index("models_lab_idx").on(table.lab),
]);

export const games = pgTable("games", {
  id: text("id").primaryKey(),
  roomCode: text("room_code").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  status: gameStatus("status").notNull().default("created"),
  finalScores: jsonb("final_scores").$type<ScoreMap>(),
  observedScores: jsonb("observed_scores").$type<ObservedScore[]>(),
}, (table) => [
  index("games_status_started_idx").on(table.status, table.startedAt),
  index("games_started_idx").on(table.startedAt),
  index("games_room_started_idx").on(table.roomCode, table.startedAt),
]);

export const gamePlayers = pgTable("game_players", {
  gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull(),
  name: varchar("name", { length: 12 }).notNull(),
  modelSlug: text("model_slug").references(() => models.slug, { onDelete: "set null" }),
  seat: integer("seat"),
  vip: boolean("vip").notNull().default(false),
  placement: integer("placement"),
  totalScore: integer("total_score"),
  observedPlacement: integer("observed_placement"),
  observedScore: integer("observed_score"),
}, (table) => [
  primaryKey({ columns: [table.gameId, table.playerId] }),
  uniqueIndex("game_players_game_seat_uidx").on(table.gameId, table.seat),
  index("game_players_model_game_idx").on(table.modelSlug, table.gameId),
  index("game_players_game_placement_idx").on(table.gameId, table.placement),
]);

export const matchups = pgTable("matchups", {
  id: text("id").primaryKey(),
  gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  round: integer("round").notNull(),
  index: integer("index").notNull(),
  prompt: text("prompt").notNull(),
  scores: jsonb("scores").$type<ScoreMap>(),
}, (table) => [
  check("matchups_round_check", sql`${table.round} in (1, 2)`),
  uniqueIndex("matchups_game_round_index_uidx").on(table.gameId, table.round, table.index),
  index("matchups_game_idx").on(table.gameId),
  index("matchups_prompt_idx").on(table.prompt),
]);

export const thriplashes = pgTable("thriplashes", {
  id: text("id").primaryKey(),
  gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  scores: jsonb("scores").$type<ScoreMap>(),
}, (table) => [
  uniqueIndex("thriplashes_game_uidx").on(table.gameId),
]);

export const answers = pgTable("answers", {
  id: text("id").primaryKey(),
  matchupId: text("matchup_id").references(() => matchups.id, { onDelete: "cascade" }),
  thriplashId: text("thriplash_id").references(() => thriplashes.id, { onDelete: "cascade" }),
  gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull(),
  answerIndex: integer("answer_index").notNull(),
  prompt: text("prompt"),
  text: text("text").notNull(),
  blank: boolean("blank").notNull().default(false),
  lines: jsonb("lines").$type<[string, string, string]>(),
  latencyMs: integer("latency_ms"),
}, (table) => [
  check(
    "answers_one_target_check",
    sql`(${table.matchupId} is not null and ${table.thriplashId} is null) or (${table.matchupId} is null and ${table.thriplashId} is not null)`,
  ),
  uniqueIndex("answers_matchup_index_uidx").on(table.matchupId, table.answerIndex),
  uniqueIndex("answers_matchup_player_uidx").on(table.matchupId, table.playerId),
  uniqueIndex("answers_thriplash_index_uidx").on(table.thriplashId, table.answerIndex),
  uniqueIndex("answers_thriplash_player_uidx").on(table.thriplashId, table.playerId),
  index("answers_game_player_idx").on(table.gameId, table.playerId),
]);

export const votes = pgTable("votes", {
  id: text("id").primaryKey(),
  gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  matchupId: text("matchup_id").references(() => matchups.id, { onDelete: "cascade" }),
  thriplashId: text("thriplash_id").references(() => thriplashes.id, { onDelete: "cascade" }),
  voterId: text("voter_id"),
  population: votePopulation("population").notNull(),
  source: voteSource("source").notNull(),
  choice: integer("choice").notNull(),
  weight: numeric("weight", { mode: "number" }).notNull().default(1),
  inferred: boolean("inferred").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  check(
    "votes_one_target_check",
    sql`(${table.matchupId} is not null and ${table.thriplashId} is null) or (${table.matchupId} is null and ${table.thriplashId} is not null)`,
  ),
  check("votes_choice_check", sql`${table.choice} >= 0`),
  check("votes_weight_check", sql`${table.weight} > 0`),
  index("votes_game_population_idx").on(table.gameId, table.population),
  index("votes_matchup_population_idx").on(table.matchupId, table.population),
  index("votes_thriplash_population_idx").on(table.thriplashId, table.population),
  index("votes_created_idx").on(table.createdAt),
]);

export const traces = pgTable("traces", {
  id: text("id").primaryKey(),
  gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull(),
  prompt: text("prompt").notNull(),
  kind: traceKind("kind").notNull(),
  reasoning: text("reasoning").notNull(),
  answer: text("answer").notNull(),
  usage: jsonb("usage").$type<JsonObject>(),
  costUsd: numeric("cost_usd", { mode: "number" }),
  modelSlug: text("model_slug").references(() => models.slug, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  index("traces_game_created_idx").on(table.gameId, table.createdAt),
  index("traces_game_player_created_idx").on(table.gameId, table.playerId, table.createdAt),
  index("traces_model_created_idx").on(table.modelSlug, table.createdAt),
]);

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  gameId: text("game_id").references(() => games.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<GameEvent>().notNull(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  eventKey: text("event_key").notNull(),
}, (table) => [
  uniqueIndex("events_event_key_uidx").on(table.eventKey),
  index("events_game_id_idx").on(table.gameId, table.id),
  index("events_type_at_idx").on(table.type, table.at),
]);

export const ratingSnapshots = pgTable("rating_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  population: ratingPopulation("population").notNull(),
  method: text("method").notNull(),
  results: jsonb("results").$type<unknown>().notNull(),
}, (table) => [
  index("rating_snapshots_population_computed_idx").on(table.population, table.computedAt),
]);

export const schema = {
  models,
  games,
  gamePlayers,
  matchups,
  answers,
  thriplashes,
  votes,
  traces,
  events,
  ratingSnapshots,
};
