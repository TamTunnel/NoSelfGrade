import { describe, expect, it } from "vitest";
import { FAMILY_TABLE, listModels, lookupModel } from "../src/families.js";

describe("FAMILY_TABLE", () => {
  it("every entry has non-empty model, family, and provider", () => {
    expect(FAMILY_TABLE.length).toBeGreaterThan(0);
    for (const e of FAMILY_TABLE) {
      expect(e.model.trim().length, `model for ${JSON.stringify(e)}`).toBeGreaterThan(0);
      expect(e.family.trim().length, `family for ${e.model}`).toBeGreaterThan(0);
      expect(e.provider.trim().length, `provider for ${e.model}`).toBeGreaterThan(0);
    }
  });

  it("has no duplicate model ids", () => {
    const ids = FAMILY_TABLE.map((e) => e.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all eight expected families", () => {
    const families = new Set(FAMILY_TABLE.map((e) => e.family));
    for (const f of ["claude", "gpt", "grok", "gemini", "llama", "deepseek", "mistral", "qwen"]) {
      expect(families.has(f), `missing family ${f}`).toBe(true);
    }
  });
});

describe("lookupModel", () => {
  it("finds exact matches", () => {
    expect(lookupModel("gpt-4o")).toEqual({
      model: "gpt-4o",
      family: "gpt",
      provider: "openai",
    });
    expect(lookupModel("claude-sonnet-4-5")?.family).toBe("claude");
  });

  it("falls back to case-insensitive match", () => {
    expect(lookupModel("GPT-4O")?.model).toBe("gpt-4o");
    expect(lookupModel("Claude-Sonnet-4-5")?.family).toBe("claude");
    expect(lookupModel("Qwen/Qwen3-235B-A22B")?.family).toBe("qwen");
  });

  it("prefers exact over case-insensitive", () => {
    // exact entry exists; result must be the exact-cased row
    const hit = lookupModel("deepseek-chat");
    expect(hit?.model).toBe("deepseek-chat");
  });

  it("returns undefined for unknown models", () => {
    expect(lookupModel("gpt-99-ultra")).toBeUndefined();
    expect(lookupModel("")).toBeUndefined();
    expect(lookupModel("not-a-real-model")).toBeUndefined();
  });
});

describe("listModels", () => {
  it("returns a copy of the whole table", () => {
    const list = listModels();
    expect(list).toHaveLength(FAMILY_TABLE.length);
    expect(list).toEqual(FAMILY_TABLE);
    expect(list).not.toBe(FAMILY_TABLE);
  });
});
