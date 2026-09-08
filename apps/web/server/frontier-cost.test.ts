import { describe, expect, it } from "vitest";
import { frontierCost } from "./frontier-cost.js";

describe("historical frontier promotion reversals", () => {
  const at = "2026-09-07T23:00:00Z";
  it("preserves cache savings when reversing the uniform discount", () => {
    // 1000 input tokens, 800 cached, 100 output tokens.
    const solarBilled = (200 * .03 + 800 * .006 + 100 * .12) / 1e6;
    const mercuryBilled = (200 * .04 + 800 * .004 + 100 * .15) / 1e6;
    expect(frontierCost("upstage/solar-pro4", solarBilled, at))
      .toBeCloseTo((200 * .30 + 800 * .06 + 100 * 1.20) / 1e6, 12);
    expect(frontierCost("inception/mercury-2.5-preview", mercuryBilled, at))
      .toBeCloseTo((200 * .20 + 800 * .02 + 100 * .75) / 1e6, 12);
  });
  it("leaves unknown costs, unaudited models, and dates outside the audit unchanged", () => {
    expect(frontierCost("upstage/solar-pro4", null, at)).toBeNull();
    expect(frontierCost("upstage/solar-pro4", 0, at)).toBe(0);
    for (const slug of ["google/gemini-3.8-flash", "z-ai/glm-5.3-flash"])
      expect(frontierCost(slug, .01, at)).toBe(.01);
    for (const date of ["2026-09-02T23:59:59Z", "2026-09-08T01:48:00Z", "invalid"])
      expect(frontierCost("upstage/solar-pro4", .01, date)).toBe(.01);
  });
});
