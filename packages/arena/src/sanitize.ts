export const DEFAULT_ANSWER_LIMIT = 45;
export const DEFAULT_FALLBACK = "no comment";

export interface SanitizeOptions {
  limit?: number;
  fallback?: string;
}

const SURROUNDING_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
];

function stripMarkdown(value: string): string {
  return value
    .replace(/```(?:[\w-]+)?\s*([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/<[^>]*>/g, "");
}

function stripSurroundingQuotes(value: string): string {
  let result = value.trim();
  let changed = true;

  while (changed && result.length >= 2) {
    changed = false;
    for (const [opening, closing] of SURROUNDING_QUOTES) {
      if (result.startsWith(opening) && result.endsWith(closing)) {
        result = result.slice(opening.length, -closing.length).trim();
        changed = true;
        break;
      }
    }
  }

  return result;
}

function clean(value: string, limit: number): string {
  const withoutNonBmp = value.replace(/[\u{10000}-\u{10ffff}]/gu, "");
  const plain = stripSurroundingQuotes(stripMarkdown(withoutNonBmp))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/u, "")
    .trim();

  return plain.slice(0, limit).trim().replace(/\.+$/u, "").trim();
}

/** Normalize a model response into text that Quiplash can safely submit. */
export function sanitizeAnswer(value: string, options: SanitizeOptions = {}): string {
  const limit = options.limit ?? DEFAULT_ANSWER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Answer limit must be a positive integer");
  }

  const answer = clean(value, limit);
  if (/[\p{L}\p{N}]/u.test(answer)) return answer;

  const fallback = clean(options.fallback ?? DEFAULT_FALLBACK, limit);
  return fallback || DEFAULT_FALLBACK.slice(0, limit);
}

function parseJsonArray(value: string): string[] | undefined {
  const withoutFence = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const candidates = [withoutFence];
  const start = withoutFence.indexOf("[");
  const end = withoutFence.lastIndexOf("]");
  if (start >= 0 && end > start) candidates.push(withoutFence.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (typeof item === "string" ? item : String(item ?? "")));
      }
    } catch {
      // A line-oriented fallback handles models that ignored the JSON convention.
    }
  }
  return undefined;
}

/** Parse Thriplash output, preferring a JSON string array but tolerating plain text. */
export function parseFinalAnswers(
  value: string,
  options: SanitizeOptions = {},
): [string, string, string] {
  const limit = options.limit ?? DEFAULT_ANSWER_LIMIT;
  const fallback = sanitizeAnswer(options.fallback ?? DEFAULT_FALLBACK, { limit });
  let parts = parseJsonArray(value);

  if (!parts) {
    const withoutFences = value.replace(/^```(?:\w+)?\s*$/gim, "").trim();
    const lines = withoutFences
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    parts = lines.length >= 2
      ? lines
      : withoutFences.split(/\s*,\s*/).map((part) => part.trim()).filter(Boolean);
  }

  const answers = parts.slice(0, 3).map((part) => sanitizeAnswer(part, { limit, fallback }));
  while (answers.length < 3) answers.push(fallback);
  return [answers[0] ?? fallback, answers[1] ?? fallback, answers[2] ?? fallback];
}

/** Parse an A/B-style or one-based numeric model vote. Zero is also accepted. */
export function parseVote(value: string, optionCount: number): number | undefined {
  if (!Number.isInteger(optionCount) || optionCount < 1) return undefined;

  const text = stripSurroundingQuotes(stripMarkdown(value)).replace(/\s+/g, " ").trim();
  const prefixed = text.match(
    /\b(?:option|answer|choice|pick|choose|select(?:ed)?)\s*(?:is\s*)?[:#-]?\s*([A-Z]|\d+)\b/i,
  );
  const exact = text.match(/^\s*([A-Z]|\d+)\s*[).:!?-]*\s*$/i);
  const token = prefixed?.[1] ?? exact?.[1];
  if (!token) return undefined;

  if (/^[A-Z]$/i.test(token)) {
    const index = token.toUpperCase().charCodeAt(0) - 65;
    return index < optionCount ? index : undefined;
  }

  const numeric = Number.parseInt(token, 10);
  if (numeric === 0) return 0;
  return numeric >= 1 && numeric <= optionCount ? numeric - 1 : undefined;
}
