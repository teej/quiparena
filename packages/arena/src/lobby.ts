export interface LobbyRosterModel {
  slug: string;
  displayName?: string;
  enabled: boolean;
  fixed?: boolean | undefined;
}

export interface LobbyPlayerResult {
  id?: string;
  playerId?: string;
  slug?: string;
  modelId?: string | null;
  modelSlug?: string | null;
  placement?: number;
  totalScore?: number;
}

export interface LobbyGameHistory {
  id?: string;
  players: readonly (string | LobbyPlayerResult)[];
  finalScores?: Readonly<Record<string, number>>;
  placements?: Readonly<Record<string, number>>;
  failures?: readonly string[];
  failedModels?: readonly string[];
  failedModelSlugs?: readonly string[];
  budget?: Readonly<Record<string, LobbyModelBudgetMetrics>>;
  /** Durable post-game snapshot used when seeding a worker through the archive API. */
  benchStates?: Readonly<Record<string, ModelBenchState>>;
  status?: string;
}

export interface LobbyModelBudgetMetrics {
  misses: number;
  answerLatenciesMs: readonly number[];
}

export interface LobbyModelAttempt {
  modelSlug: string;
  success: boolean;
}

export type LobbyHistoryEntry = LobbyGameHistory | LobbyModelAttempt;

export interface BenchRule {
  /** A game triggers a bench when misses exceed this value. */
  maxBudgetMisses: number;
  /** Answer/Thriplash p50 is slow when it exceeds this budget. */
  answerBudgetMs: number;
  /** Number of consecutive slow appearances that trigger a bench. */
  consecutiveSlowGames: number;
  /** Number of subsequent arena games for which a model is excluded. */
  benchGames: number;
}

export interface ModelBenchState {
  benched: boolean;
  gamesRemaining: number;
  consecutiveSlowGames: number;
  reason?: string;
  benchedAtGameId?: string;
  updatedAtGameId?: string;
}

export interface BenchStateChange {
  modelSlug: string;
  action: "benched" | "unbenched";
  reason: string;
  gamesRemaining: number;
}

export interface PickNextLobbyOptions<T extends LobbyRosterModel> {
  roster: readonly T[] | { models: readonly T[] };
  lastGame?: LobbyGameHistory | null;
  history: readonly LobbyHistoryEntry[];
  size?: number;
  keep?: number;
  /** Uniform sampling is the default; legacy rotation is explicitly opt-in. */
  selection?: "random" | "rotation";
  /** Overrides roster fixed flags; an empty list disables fixed seats. */
  fixedModels?: readonly string[];
  bench?: false | Partial<BenchRule>;
  benchStates?: ReadonlyMap<string, ModelBenchState> | Readonly<Record<string, ModelBenchState>>;
  rng?: () => number;
  /** Alias for rng, matching the model-player injection convention. */
  random?: () => number;
  onPick?: (pick: LobbyPickRationale<T>) => void;
}

export interface LobbyPickRationale<T extends LobbyRosterModel> {
  model: T;
  role: "keeper" | "fixed" | "rotation";
  gamesPlayed: number;
  weight?: number;
  placement?: number;
  totalScore?: number;
  fresh?: boolean;
}

export const DEFAULT_BENCH_RULE: BenchRule = {
  maxBudgetMisses: 2,
  answerBudgetMs: 15_000,
  consecutiveSlowGames: 2,
  benchGames: 10,
};

function rosterModels<T extends LobbyRosterModel>(
  roster: readonly T[] | { models: readonly T[] },
): readonly T[] {
  return "models" in roster ? roster.models : roster;
}

function playerSlug(player: string | LobbyPlayerResult): string | undefined {
  if (typeof player === "string") return player;
  return player.modelSlug ?? player.modelId ?? player.slug;
}

function playerId(player: string | LobbyPlayerResult): string | undefined {
  if (typeof player === "string") return player;
  return player.playerId ?? player.id ?? playerSlug(player);
}

function participants(entry: LobbyGameHistory): Set<string> {
  return new Set(entry.players.map(playerSlug).filter((slug): slug is string => Boolean(slug)));
}

function entryIdentity(entry: LobbyGameHistory): string | LobbyGameHistory {
  return entry.id ?? entry;
}

function withLastGame(
  history: readonly LobbyHistoryEntry[],
  lastGame: LobbyGameHistory | null | undefined,
): LobbyHistoryEntry[] {
  if (!lastGame) return [...history];
  const identity = entryIdentity(lastGame);
  const alreadyIncluded = history.some((entry) => (
    "players" in entry && entryIdentity(entry) === identity
  ));
  return alreadyIncluded ? [...history] : [...history, lastGame];
}

function gamesPlayed(history: readonly LobbyHistoryEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of history) {
    const slugs = "players" in entry ? participants(entry) : new Set([entry.modelSlug]);
    for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return counts;
}

function percentile50(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

function stateMap(
  states: ReadonlyMap<string, ModelBenchState> | Readonly<Record<string, ModelBenchState>>,
): Map<string, ModelBenchState> {
  return states instanceof Map
    ? new Map([...states].map(([slug, state]) => [slug, { ...state }]))
    : new Map(Object.entries(states).map(([slug, state]) => [slug, { ...state }]));
}

/** Advance persisted slow-model state by one completed game. */
export function advanceBenchStates(
  states: ReadonlyMap<string, ModelBenchState> | Readonly<Record<string, ModelBenchState>>,
  game: LobbyGameHistory,
  partialRule: Partial<BenchRule> = {},
): { states: Map<string, ModelBenchState>; changes: BenchStateChange[] } {
  const rule = { ...DEFAULT_BENCH_RULE, ...partialRule };
  if (!Number.isInteger(rule.maxBudgetMisses) || rule.maxBudgetMisses < 0) {
    throw new RangeError("maxBudgetMisses must be a non-negative integer");
  }
  if (!Number.isFinite(rule.answerBudgetMs) || rule.answerBudgetMs <= 0) {
    throw new RangeError("answerBudgetMs must be positive");
  }
  if (!Number.isInteger(rule.consecutiveSlowGames) || rule.consecutiveSlowGames < 1) {
    throw new RangeError("consecutiveSlowGames must be a positive integer");
  }
  if (!Number.isInteger(rule.benchGames) || rule.benchGames < 1) {
    throw new RangeError("benchGames must be a positive integer");
  }

  const next = stateMap(states);
  const changes: BenchStateChange[] = [];
  const benchedDuringGame = new Set<string>();
  for (const [slug, state] of next) {
    if (!state.benched) continue;
    benchedDuringGame.add(slug);
    const gamesRemaining = Math.max(0, state.gamesRemaining - 1);
    if (gamesRemaining > 0) {
      next.set(slug, {
        ...state,
        gamesRemaining,
        ...(game.id === undefined ? {} : { updatedAtGameId: game.id }),
      });
      continue;
    }
    next.delete(slug);
    changes.push({
      modelSlug: slug,
      action: "unbenched",
      reason: `served ${rule.benchGames}-game bench`,
      gamesRemaining: 0,
    });
  }

  for (const slug of participants(game)) {
    if (benchedDuringGame.has(slug)) continue;
    const metrics = game.budget?.[slug] ?? { misses: 0, answerLatenciesMs: [] };
    const p50 = percentile50(metrics.answerLatenciesMs);
    const previousSlowGames = next.get(slug)?.consecutiveSlowGames ?? 0;
    const consecutiveSlowGames = p50 !== undefined && p50 > rule.answerBudgetMs
      ? previousSlowGames + 1
      : 0;

    let reason: string | undefined;
    if (metrics.misses > rule.maxBudgetMisses) {
      reason = `${metrics.misses} budget misses in game ${game.id ?? "unknown"} (limit ${rule.maxBudgetMisses})`;
    } else if (consecutiveSlowGames >= rule.consecutiveSlowGames) {
      reason = `p50 answer latency ${p50}ms exceeded ${rule.answerBudgetMs}ms in ${consecutiveSlowGames} consecutive games`;
    }

    if (reason) {
      next.set(slug, {
        benched: true,
        gamesRemaining: rule.benchGames,
        consecutiveSlowGames: 0,
        reason,
        ...(game.id === undefined ? {} : {
          benchedAtGameId: game.id,
          updatedAtGameId: game.id,
        }),
      });
      changes.push({
        modelSlug: slug,
        action: "benched",
        reason,
        gamesRemaining: rule.benchGames,
      });
    } else if (consecutiveSlowGames > 0) {
      next.set(slug, {
        benched: false,
        gamesRemaining: 0,
        consecutiveSlowGames,
        ...(game.id === undefined ? {} : { updatedAtGameId: game.id }),
      });
    } else {
      next.delete(slug);
    }
  }
  return { states: next, changes };
}

export function deriveBenchStates(
  history: readonly LobbyHistoryEntry[],
  rule: Partial<BenchRule> = {},
): Map<string, ModelBenchState> {
  let states = new Map<string, ModelBenchState>();
  for (const entry of history) {
    if (!("players" in entry)) continue;
    states = entry.benchStates === undefined
      ? advanceBenchStates(states, entry, rule).states
      : stateMap(entry.benchStates);
  }
  return states;
}

interface RankedFinisher<T extends LobbyRosterModel> {
  model: T;
  placement?: number;
  score?: number;
}

function rankedFinishers<T extends LobbyRosterModel>(
  game: LobbyGameHistory | null | undefined,
  bySlug: ReadonlyMap<string, T>,
): RankedFinisher<T>[] {
  if (!game) return [];
  return game.players
    .map((player, order) => {
      const slug = playerSlug(player);
      const id = playerId(player);
      const model = slug ? bySlug.get(slug) : undefined;
      const explicitPlacement = typeof player === "string" ? undefined : player.placement;
      const placement = explicitPlacement ?? (id ? game.placements?.[id] : undefined)
        ?? (slug ? game.placements?.[slug] : undefined);
      const explicitScore = typeof player === "string" ? undefined : player.totalScore;
      const score = explicitScore ?? (id ? game.finalScores?.[id] : undefined)
        ?? (slug ? game.finalScores?.[slug] : undefined);
      return { model, placement, score, order };
    })
    .filter((item): item is typeof item & { model: T } => item.model !== undefined)
    .sort((left, right) => {
      if (left.placement !== undefined || right.placement !== undefined) {
        return (left.placement ?? Number.POSITIVE_INFINITY)
          - (right.placement ?? Number.POSITIVE_INFINITY) || left.order - right.order;
      }
      return (right.score ?? Number.NEGATIVE_INFINITY)
        - (left.score ?? Number.NEGATIVE_INFINITY) || left.order - right.order;
    })
    .map((item) => ({
      model: item.model,
      ...(item.placement === undefined ? {} : { placement: item.placement }),
      ...(item.score === undefined ? {} : { score: item.score }),
    }));
}

function randomSample(rng: () => number): number {
  const sample = rng();
  if (!Number.isFinite(sample)) return 0;
  return Math.min(1 - Number.EPSILON, Math.max(0, sample));
}

/**
 * Uniformly sample eligible models without replacement. Legacy weighted rotation
 * is available only with an explicit selection: "rotation".
 */
export function pickNextLobby<T extends LobbyRosterModel>(options: PickNextLobbyOptions<T>): T[] {
  const size = options.size ?? 8;
  const legacyRotation = options.selection === "rotation";
  const keep = legacyRotation ? options.keep ?? 2 : 0;
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Lobby size must be positive");
  if (!Number.isInteger(keep) || keep < 0 || keep > size) {
    throw new RangeError("keep must be between zero and the lobby size");
  }

  const allModels = rosterModels(options.roster);
  const enabled = allModels.filter((model) => model.enabled);
  const bySlug = new Map(enabled.map((model) => [model.slug, model]));
  if (bySlug.size !== enabled.length) throw new Error("Roster model slugs must be unique");
  const fixedModels = legacyRotation ? options.fixedModels ?? allModels.filter((model) => model.fixed).map((model) => model.slug) : [];
  if (new Set(fixedModels).size !== fixedModels.length) throw new Error("Fixed model slugs must be unique");
  if (fixedModels.length > Math.min(2, size - keep)) {
    throw new Error("Fixed models must fit alongside keepers, with at most two fixed seats");
  }
  for (const slug of fixedModels) {
    if (!allModels.some((model) => model.slug === slug)) throw new Error(`Unknown fixed model: ${slug}`);
  }

  const history = withLastGame(options.history, options.lastGame);
  const bench = options.bench === false
    ? null
    : { ...DEFAULT_BENCH_RULE, ...options.bench };
  const benchStates = bench === null
    ? new Map<string, ModelBenchState>()
    : options.benchStates === undefined
      ? deriveBenchStates(history, bench)
      : stateMap(options.benchStates);
  const benched = new Set([...benchStates].flatMap(([slug, state]) => state.benched ? [slug] : []));
  const eligible = enabled.filter((model) => !benched.has(model.slug));
  if (eligible.length < size) {
    throw new Error(`Cannot fill ${size} seats: only ${eligible.length} enabled, non-benched models`);
  }

  if ((options.selection ?? "random") === "random") {
    const pool = [...eligible];
    const selected: T[] = [];
    const rng = options.rng ?? options.random ?? Math.random;
    while (selected.length < size) {
      const [model] = pool.splice(Math.floor(randomSample(rng) * pool.length), 1);
      if (!model) throw new Error("Lobby selection pool was exhausted");
      selected.push(model);
      options.onPick?.({ model, role: "rotation", gamesPlayed: 0, weight: 1 });
    }
    return selected;
  }
  const selected: T[] = [];
  const selectedSlugs = new Set<string>();
  const counts = gamesPlayed(history);
  for (const finisher of rankedFinishers(options.lastGame, bySlug)) {
    if (selected.length >= keep) break;
    const { model } = finisher;
    if (benched.has(model.slug) || selectedSlugs.has(model.slug)) continue;
    selected.push(model);
    selectedSlugs.add(model.slug);
    options.onPick?.({
      model,
      role: "keeper",
      gamesPlayed: counts.get(model.slug) ?? 0,
      ...(finisher.placement === undefined ? {} : { placement: finisher.placement }),
      ...(finisher.score === undefined ? {} : { totalScore: finisher.score }),
    });
  }

  for (const slug of fixedModels) {
    const model = bySlug.get(slug);
    if (!model || benched.has(slug) || selectedSlugs.has(slug)) continue;
    selected.push(model);
    selectedSlugs.add(slug);
    options.onPick?.({ model, role: "fixed", gamesPlayed: counts.get(slug) ?? 0 });
  }

  const openSeatCount = size - selected.length;
  const lastParticipants = options.lastGame ? participants(options.lastGame) : new Set<string>();
  const freshPool = eligible.filter((model) => (
    !selectedSlugs.has(model.slug) && !lastParticipants.has(model.slug)
  ));
  // A rotation means previous non-keepers sit out when the roster is large enough.
  // If benching leaves too few fresh models, allow them back so the lobby can fill.
  const pool = freshPool.length >= openSeatCount
    ? freshPool
    : eligible.filter((model) => !selectedSlugs.has(model.slug));
  const maxGames = Math.max(0, ...pool.map((model) => counts.get(model.slug) ?? 0));
  const rng = options.rng ?? options.random ?? Math.random;
  while (selected.length < size) {
    const weights = pool.map((model) => {
      const deficit = maxGames - (counts.get(model.slug) ?? 0) + 1;
      return deficit * deficit;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = randomSample(rng) * total;
    let picked = pool.length - 1;
    for (let index = 0; index < pool.length; index += 1) {
      cursor -= weights[index] ?? 0;
      if (cursor < 0) {
        picked = index;
        break;
      }
    }
    const [model] = pool.splice(picked, 1);
    if (!model) throw new Error("Lobby selection pool was exhausted");
    selected.push(model);
    selectedSlugs.add(model.slug);
    options.onPick?.({
      model,
      role: "rotation",
      gamesPlayed: counts.get(model.slug) ?? 0,
      weight: weights[picked] ?? 0,
      fresh: !lastParticipants.has(model.slug),
    });
  }
  return selected;
}

function takeCharacters(value: string, length: number): string {
  return Array.from(value).slice(0, length).join("");
}

/** Produce game-safe, case-insensitively unique names while preserving roster order. */
export function assignDisplayNames<T extends Omit<LobbyRosterModel, "enabled">>(
  roster: readonly T[],
): Array<T & { displayName: string }> {
  const used = new Set<string>();
  return roster.map((model) => {
    const slugName = model.slug.split("/").at(-1) ?? "Model";
    const preferred = (model.displayName ?? slugName)
      .replace(/\s+/g, " ")
      .trim() || "Model";
    let candidate = takeCharacters(preferred, 12);
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase())) {
      const marker = String(suffix);
      candidate = `${takeCharacters(preferred, 12 - marker.length)}${marker}`;
      suffix += 1;
    }
    used.add(candidate.toLocaleLowerCase());
    return { ...model, displayName: candidate };
  });
}
