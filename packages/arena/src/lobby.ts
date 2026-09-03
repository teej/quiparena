export interface LobbyRosterModel {
  slug: string;
  displayName?: string;
  enabled: boolean;
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
  status?: string;
}

export interface LobbyModelAttempt {
  modelSlug: string;
  success: boolean;
}

export type LobbyHistoryEntry = LobbyGameHistory | LobbyModelAttempt;

export interface BenchRule {
  /** Bench after this many failures in the model's latest appearances. */
  consecutiveFailures: number;
  /** Only inspect this many recent history entries. */
  lookback: number;
}

export interface PickNextLobbyOptions<T extends LobbyRosterModel> {
  roster: readonly T[] | { models: readonly T[] };
  lastGame?: LobbyGameHistory | null;
  history: readonly LobbyHistoryEntry[];
  size?: number;
  keep?: number;
  bench?: false | Partial<BenchRule>;
  rng?: () => number;
  /** Alias for rng, matching the model-player injection convention. */
  random?: () => number;
}

const DEFAULT_BENCH: BenchRule = { consecutiveFailures: 2, lookback: 6 };

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

function failedModels(entry: LobbyGameHistory): Set<string> {
  const explicit = entry.failures ?? entry.failedModels ?? entry.failedModelSlugs;
  if (explicit) return new Set(explicit);
  return entry.status === "failed" ? participants(entry) : new Set();
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

function isBenched(
  slug: string,
  history: readonly LobbyHistoryEntry[],
  rule: BenchRule,
): boolean {
  if (rule.consecutiveFailures < 1 || rule.lookback < 1) return false;
  let failures = 0;
  const recent = history.slice(-rule.lookback).reverse();
  for (const entry of recent) {
    if ("modelSlug" in entry) {
      if (entry.modelSlug !== slug) continue;
      if (entry.success) break;
      failures += 1;
    } else {
      if (!participants(entry).has(slug)) continue;
      if (!failedModels(entry).has(slug)) break;
      failures += 1;
    }
    if (failures >= rule.consecutiveFailures) return true;
  }
  return false;
}

function rankedFinishers<T extends LobbyRosterModel>(
  game: LobbyGameHistory | null | undefined,
  bySlug: ReadonlyMap<string, T>,
): T[] {
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
    .map((item) => item.model);
}

function randomSample(rng: () => number): number {
  const sample = rng();
  if (!Number.isFinite(sample)) return 0;
  return Math.min(1 - Number.EPSILON, Math.max(0, sample));
}

/**
 * Rotate a lobby without replacement. Returning finishers stay at the front;
 * open seats use a weighted draw that strongly favors underplayed models.
 */
export function pickNextLobby<T extends LobbyRosterModel>(options: PickNextLobbyOptions<T>): T[] {
  const size = options.size ?? 8;
  const keep = options.keep ?? 2;
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Lobby size must be positive");
  if (!Number.isInteger(keep) || keep < 0 || keep > size) {
    throw new RangeError("keep must be between zero and the lobby size");
  }

  const allModels = rosterModels(options.roster);
  const enabled = allModels.filter((model) => model.enabled);
  const bySlug = new Map(enabled.map((model) => [model.slug, model]));
  if (bySlug.size !== enabled.length) throw new Error("Roster model slugs must be unique");

  const history = withLastGame(options.history, options.lastGame);
  const bench = options.bench === false
    ? null
    : { ...DEFAULT_BENCH, ...options.bench };
  const benched = new Set(
    bench ? enabled.filter((model) => isBenched(model.slug, history, bench)).map((model) => model.slug) : [],
  );
  const eligible = enabled.filter((model) => !benched.has(model.slug));
  if (eligible.length < size) {
    throw new Error(`Cannot fill ${size} seats: only ${eligible.length} enabled, non-benched models`);
  }

  const selected: T[] = [];
  const selectedSlugs = new Set<string>();
  for (const model of rankedFinishers(options.lastGame, bySlug)) {
    if (selected.length >= keep) break;
    if (benched.has(model.slug) || selectedSlugs.has(model.slug)) continue;
    selected.push(model);
    selectedSlugs.add(model.slug);
  }

  const counts = gamesPlayed(history);
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
