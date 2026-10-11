import { describe, expect, it } from "vitest";
import { buildRepairPrompt, buildReviewPrompt } from "../src/prompts.js";

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
 export function check(token: string) {
+  if (token === "secret") return true;
   return false;
 }
`;

describe("buildReviewPrompt", () => {
  it("contains the full diff in a clearly delimited block", () => {
    const prompt = buildReviewPrompt(SAMPLE_DIFF);
    expect(prompt).toContain("===== BEGIN DIFF =====");
    expect(prompt).toContain("===== END DIFF =====");
    expect(prompt).toContain(SAMPLE_DIFF);
  });

  it("describes the JSON findings schema", () => {
    const prompt = buildReviewPrompt(SAMPLE_DIFF);
    for (const key of [
      '"findings"',
      '"severity"',
      '"file"',
      '"line"',
      '"category"',
      '"confidence"',
      '"message"',
      '"remediation"',
      '"snippet"',
    ]) {
      expect(prompt).toContain(key);
    }
    expect(prompt).toContain("critical");
    expect(prompt).toContain("correctness");
    expect(prompt).toContain("security");
  });

  it("demands JSON-only output with no markdown fences or prose", () => {
    const prompt = buildReviewPrompt(SAMPLE_DIFF);
    expect(prompt).toContain("Return ONLY the JSON");
    expect(prompt.toLowerCase()).toContain("no markdown fences");
  });

  it("contains no builder identity or framing", () => {
    const prompt = buildReviewPrompt(SAMPLE_DIFF);
    const lowered = prompt.toLowerCase();
    expect(lowered).not.toContain("builder");
    expect(lowered).not.toContain("gpt-4");
    expect(lowered).not.toContain("claude");
    expect(lowered).not.toContain("declared");
    // The prompt must say who the reviewer is relative to the author, but
    // must not name any specific model or builder.
    expect(prompt).toContain("independent code reviewer");
  });

  it("does not leak builder identity even when the diff mentions a model", () => {
    const tricky = SAMPLE_DIFF + '\n// written by gpt-4 while the builder slept\n';
    const prompt = buildReviewPrompt(tricky);
    // The diff itself is included verbatim (it's the reviewed artifact);
    // the *prompt framing* adds no builder language of its own.
    const before = prompt.split("===== BEGIN DIFF =====")[0];
    expect(before.toLowerCase()).not.toContain("builder");
  });
});

describe("buildRepairPrompt", () => {
  it("includes the broken output and the error", () => {
    const broken = "{ not json";
    const error = "Unexpected token n in JSON";
    const prompt = buildRepairPrompt(broken, error);
    expect(prompt).toContain(broken);
    expect(prompt).toContain(error);
  });

  it("asks for corrected JSON in the same schema, nothing else", () => {
    const prompt = buildRepairPrompt("{}", "some error");
    expect(prompt).toContain("Return ONLY the corrected JSON");
    expect(prompt).toContain('"findings"');
  });

  it("contains no builder identity language", () => {
    const prompt = buildRepairPrompt("{}", "err");
    expect(prompt.toLowerCase()).not.toContain("builder");
  });
});
