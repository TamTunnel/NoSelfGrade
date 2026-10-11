import { describe, expect, it } from "vitest";
import { parseBuilderDeclaration } from "../src/builder.js";
import { DEFAULT_REVIEWERS, selectReviewers } from "../src/dispatch.js";
import { FAMILY_TABLE, lookupModel } from "../src/families.js";

describe("selectReviewers independence property", () => {
  for (const entry of FAMILY_TABLE) {
    it(`single mode: no reviewer shares family or provider with builder "${entry.model}"`, () => {
      const builder = parseBuilderDeclaration({ model: entry.model });
      const builderFamily = lookupModel(builder.model)!.family;
      const reviewers = selectReviewers(builder, DEFAULT_REVIEWERS, false);
      expect(reviewers).toHaveLength(1);
      const [r] = reviewers;
      expect(r.family, `reviewer family for builder ${builder.model}`).not.toBe(builderFamily);
      expect(r.provider, `reviewer provider for builder ${builder.model}`).not.toBe(builder.provider);
    });

    it(`jury mode: reviewers disjoint, distinct providers, <= 3 for builder "${entry.model}"`, () => {
      const builder = parseBuilderDeclaration({ model: entry.model });
      const builderFamily = lookupModel(builder.model)!.family;
      const reviewers = selectReviewers(builder, DEFAULT_REVIEWERS, true);
      expect(reviewers.length).toBeGreaterThan(0);
      expect(reviewers.length).toBeLessThanOrEqual(3);
      const providers = reviewers.map((r) => r.provider);
      expect(new Set(providers).size).toBe(providers.length);
      for (const r of reviewers) {
        expect(r.family, `jury reviewer family for builder ${builder.model}`).not.toBe(builderFamily);
        expect(r.provider, `jury reviewer provider for builder ${builder.model}`).not.toBe(builder.provider);
      }
    });
  }

  it("is deterministic: same builder always gets the same single reviewer", () => {
    const builder = parseBuilderDeclaration({ model: "gpt-4o" });
    const a = selectReviewers(builder, DEFAULT_REVIEWERS, false);
    const b = selectReviewers(builder, DEFAULT_REVIEWERS, false);
    expect(a).toEqual(b);
  });
});
