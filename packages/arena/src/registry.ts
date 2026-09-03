import { readFile } from "node:fs/promises";

import { z } from "zod";

const reasoningSchema = z.union([
  z.object({ effort: z.enum(["xhigh", "high", "medium", "low", "minimal", "none"]) }).strict(),
  z.object({
    maxTokens: z.number().int().positive(),
    voteMaxTokens: z.number().int().positive().optional(),
    thriplashMaxTokens: z.number().int().positive().optional(),
  }).strict(),
]);

const rosterModelSchema = z.object({
  slug: z.string().min(3).regex(/^[^/\s]+\/[^\s]+$/),
  displayName: z.string().min(1).max(12),
  lab: z.string().min(1),
  released: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reasoning: reasoningSchema.nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  enabled: z.boolean(),
  disabledReason: z.string().min(1).optional(),
  rationale: z.string().min(1),
}).strict();

const rosterSchema = z.object({
  reviewStatus: z.literal("to be reviewed by TJ"),
  catalogCheckedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  models: z.array(rosterModelSchema).min(1),
}).strict().superRefine((roster, ctx) => {
  const seenSlugs = new Set<string>();
  const seenNames = new Set<string>();
  roster.models.forEach((model, index) => {
    if (!model.enabled && model.disabledReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Disabled models must include disabledReason",
        path: ["models", index, "disabledReason"],
      });
    }
    if (seenSlugs.has(model.slug)) {
      ctx.addIssue({ code: "custom", message: `Duplicate slug: ${model.slug}`, path: ["models", index, "slug"] });
    }
    if (seenNames.has(model.displayName.toLowerCase())) {
      ctx.addIssue({ code: "custom", message: `Duplicate display name: ${model.displayName}`, path: ["models", index, "displayName"] });
    }
    seenSlugs.add(model.slug);
    seenNames.add(model.displayName.toLowerCase());
  });
});

export type RosterModel = z.infer<typeof rosterModelSchema>;
export type ModelRoster = z.infer<typeof rosterSchema>;

interface CatalogModel {
  id: string;
  architecture?: {
    input_modalities?: string[] | undefined;
    output_modalities?: string[] | undefined;
  } | undefined;
  supported_parameters?: string[] | undefined;
  expiration_date?: string | null | undefined;
}

const catalogSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    architecture: z.object({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    }).optional(),
    supported_parameters: z.array(z.string()).optional(),
    expiration_date: z.string().nullable().optional(),
  }).passthrough()),
}).passthrough();

export interface UnsupportedRosterModel {
  slug: string;
  reasons: string[];
}

export interface RosterValidationReport {
  ok: boolean;
  checked: number;
  catalogSize: number;
  unknown: string[];
  unsupported: UnsupportedRosterModel[];
}

export interface ValidateRosterOptions {
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  now?: Date;
}

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export async function loadRoster(
  source: string | URL = new URL("../models.json", import.meta.url),
): Promise<ModelRoster> {
  const contents = await readFile(source, "utf8");
  return rosterSchema.parse(JSON.parse(contents));
}

function unsupportedReasons(entry: RosterModel, model: CatalogModel, now: Date): string[] {
  const reasons: string[] = [];
  const inputModalities = model.architecture?.input_modalities ?? [];
  const outputModalities = model.architecture?.output_modalities ?? [];
  const parameters = new Set(model.supported_parameters ?? []);

  if (!inputModalities.includes("text")) reasons.push("does not advertise text input");
  if (!outputModalities.includes("text")) reasons.push("does not advertise text output");
  if (!parameters.has("max_tokens") && !parameters.has("max_completion_tokens")) {
    reasons.push("does not advertise an output-token limit");
  }
  if (entry.reasoning !== null && !parameters.has("reasoning")) {
    reasons.push("roster config requests reasoning but the model does not advertise it");
  }
  if (entry.temperature !== null && !parameters.has("temperature")) {
    reasons.push("roster config requests temperature but the model does not advertise it");
  }
  if (model.expiration_date && Date.parse(model.expiration_date) <= now.getTime()) {
    reasons.push(`expired on ${model.expiration_date}`);
  }
  return reasons;
}

export async function validateRoster(
  roster: ModelRoster,
  options: ValidateRosterOptions = {},
): Promise<RosterValidationReport> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(options.endpoint ?? OPENROUTER_MODELS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog returned ${response.status} ${response.statusText}`);
  }

  const parsed = catalogSchema.parse(await response.json());
  const catalog = new Map(parsed.data.map((model) => [model.id, model]));
  const unknown: string[] = [];
  const unsupported: UnsupportedRosterModel[] = [];

  for (const entry of roster.models) {
    const model = catalog.get(entry.slug);
    if (!model) {
      unknown.push(entry.slug);
      continue;
    }
    const reasons = unsupportedReasons(entry, model, options.now ?? new Date());
    if (reasons.length > 0) unsupported.push({ slug: entry.slug, reasons });
  }

  return {
    ok: unknown.length === 0 && unsupported.length === 0,
    checked: roster.models.length,
    catalogSize: catalog.size,
    unknown,
    unsupported,
  };
}

export function findRosterModel(roster: ModelRoster, slug: string): RosterModel | undefined {
  return roster.models.find((model) => model.slug === slug);
}
