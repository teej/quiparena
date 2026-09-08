/** Historical, audited promotion reversals. Never rewrite the billing ledger.
 * Every priced trace in this interval fits the promotional input/output/cache
 * rates, and both models were served exclusively by the promoting vendor.
 * Solar: https://www.upstage.ai/blog/en/solar-pro-4 (90% off)
 * Mercury: https://openrouter.ai/inception/mercury-2.5-preview (80% off)
 * Bound the adjustment to the audited history; future calls need a fresh audit.
 */
export function frontierCost(modelSlug: string, billed: number | null, at: string | Date): number | null {
  if (billed === null) return null;
  const time = new Date(at).getTime();
  if (!(time >= Date.parse("2026-09-03T00:00:00Z") && time < Date.parse("2026-09-08T01:48:00Z"))) return billed;
  if (modelSlug === "upstage/solar-pro4") return billed * 10;
  if (modelSlug === "inception/mercury-2.5-preview") return billed * 5;
  return billed;
}
