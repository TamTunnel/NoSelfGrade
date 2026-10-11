import { describe, expect, it } from "vitest";
import type { Finding } from "../src/types.js";
import {
  dedupeFindings,
  extractJson,
  FindingParseError,
  mergeJuryFindings,
  normalizeFindings,
  parseReviewResponse,
  type RawFinding,
} from "../src/findings.js";

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index aaa..bbb 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,5 +1,7 @@
 import { hash } from "./crypto";
 export function login(user: string, pw: string) {
+  // TODO: use constant-time compare
+  if (pw === "hunter2") return adminSession();
   const h = hash(pw);
   return check(h);
 }
`;

const VALID_RESPONSE = `{
  "findings": [
    {
      "severity": "critical",
      "file": "src/auth.ts",
      "line": 4,
      "category": "security",
      "confidence": 0.95,
      "message": "Hardcoded password grants admin access",
      "remediation": "Remove the hardcoded check and verify against the stored hash.",
      "snippet": "if (pw === \\"hunter2\\") return adminSession();"
    },
    {
      "severity": "low",
      "file": "src/auth.ts",
      "line": null,
      "category": "style",
      "confidence": 0.4,
      "message": "Comment could be clearer"
    }
  ]
}`;

const FENCED_RESPONSE = `Here is my review:
\`\`\`json
${VALID_RESPONSE}
\`\`\`
`;

function rawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    severity: "high",
    file: "src/auth.ts",
    line: 4,
    category: "correctness",
    confidence: 0.8,
    message: "Something is wrong",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "high",
    file: "src/auth.ts",
    line: 4,
    category: "correctness",
    confidence: 0.8,
    message: "Something is wrong",
    reviewer: "reviewer-a",
    ...overrides,
  };
}

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson(VALID_RESPONSE)).toMatchObject({ findings: expect.any(Array) });
  });

  it("strips markdown fences", () => {
    const parsed = extractJson(FENCED_RESPONSE) as { findings: unknown[] };
    expect(parsed.findings).toHaveLength(2);
  });

  it("strips plain fences without a language tag", () => {
    expect(extractJson("```\n" + VALID_RESPONSE + "\n```")).toMatchObject({
      findings: expect.any(Array),
    });
  });

  it("ignores prose around the JSON object", () => {
    const parsed = extractJson("Some intro text\n" + VALID_RESPONSE + "\nSome trailing text");
    expect(parsed).toMatchObject({ findings: expect.any(Array) });
  });

  it("handles braces inside string literals", () => {
    const text = `{"findings": [{"severity": "low", "file": "a", "line": null, "category": "style", "confidence": 0.5, "message": "brace { in message"}]}`;
    const parsed = extractJson(text) as { findings: { message: string }[] };
    expect(parsed.findings[0].message).toBe("brace { in message");
  });

  it("throws FindingParseError when no JSON object is present", () => {
    expect(() => extractJson("no json here at all")).toThrow(FindingParseError);
  });

  it("throws FindingParseError on unbalanced braces", () => {
    expect(() => extractJson('{"findings": [')).toThrow(FindingParseError);
  });

  it("throws FindingParseError on invalid JSON", () => {
    expect(() => extractJson("{ not valid json }")).toThrow(FindingParseError);
  });
});

describe("parseReviewResponse", () => {
  it("parses a valid response into raw findings", () => {
    const raw = parseReviewResponse(VALID_RESPONSE, "reviewer-a");
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({
      severity: "critical",
      file: "src/auth.ts",
      line: 4,
      category: "security",
      confidence: 0.95,
      message: "Hardcoded password grants admin access",
    });
    expect(raw[1].line).toBeNull();
    expect(raw[1].remediation).toBeUndefined();
  });

  it("parses markdown-fenced responses", () => {
    const raw = parseReviewResponse(FENCED_RESPONSE, "reviewer-a");
    expect(raw).toHaveLength(2);
  });

  it("parses an empty findings array", () => {
    expect(parseReviewResponse('{"findings": []}', "reviewer-a")).toEqual([]);
  });

  it("throws FindingParseError with an actionable message on malformed JSON", () => {
    expect(() => parseReviewResponse("{oops", "reviewer-a")).toThrow(FindingParseError);
    expect(() => parseReviewResponse("just prose", "reviewer-a")).toThrow(FindingParseError);
  });

  it("throws when the findings key is missing", () => {
    expect(() => parseReviewResponse('{"results": []}', "reviewer-a")).toThrow(
      /missing the "findings" array/,
    );
  });

  it("throws when findings is not an array", () => {
    expect(() => parseReviewResponse('{"findings": {}}', "reviewer-a")).toThrow(FindingParseError);
  });

  it("throws when a required field has the wrong type", () => {
    const bad = `{"findings": [{"severity": 5, "file": "a", "line": null, "category": "style", "confidence": 0.5, "message": "x"}]}`;
    expect(() => parseReviewResponse(bad, "reviewer-a")).toThrow(/"severity"/);
  });

  it("throws when line is a non-integer", () => {
    const bad = `{"findings": [{"severity": "low", "file": "a", "line": "four", "category": "style", "confidence": 0.5, "message": "x"}]}`;
    expect(() => parseReviewResponse(bad, "reviewer-a")).toThrow(/"line"/);
  });

  it("defaults a missing line to null and missing confidence to 0.5", () => {
    const minimal = `{"findings": [{"severity": "low", "file": "a", "category": "style", "message": "x"}]}`;
    const raw = parseReviewResponse(minimal, "reviewer-a");
    expect(raw[0].line).toBeNull();
    expect(raw[0].confidence).toBe(0.5);
  });
});

describe("normalizeFindings", () => {
  it("normalizes a well-formed finding and sets the reviewer", () => {
    const out = normalizeFindings([rawFinding()], "claude-opus-4-6", DIFF);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: "high",
      file: "src/auth.ts",
      line: 4,
      category: "correctness",
      confidence: 0.8,
      message: "Something is wrong",
      reviewer: "claude-opus-4-6",
    });
  });

  it("maps severity synonyms", () => {
    const cases: [string, string][] = [
      ["crit", "critical"],
      ["CRIT", "critical"],
      ["warn", "medium"],
      ["warning", "medium"],
      ["error", "high"],
      ["note", "info"],
      ["suggestion", "low"],
    ];
    for (const [input, expected] of cases) {
      const out = normalizeFindings([rawFinding({ severity: input })], "r", DIFF);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe(expected);
    }
  });

  it("drops findings with unknown severity without failing the run", () => {
    const out = normalizeFindings(
      [rawFinding({ severity: "catastrophic" }), rawFinding({ severity: "high" })],
      "r",
      DIFF,
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
  });

  it("maps category synonyms and defaults unknown categories to correctness", () => {
    const cases: [string, string][] = [
      ["bug", "correctness"],
      ["vulnerability", "security"],
      ["performance", "perf"],
      ["PERF", "perf"],
      ["nonsense-category", "correctness"],
    ];
    for (const [input, expected] of cases) {
      const out = normalizeFindings([rawFinding({ category: input })], "r", DIFF);
      expect(out[0].category).toBe(expected);
    }
  });

  it("clamps confidence to 0..1 and defaults non-numbers to 0.5", () => {
    const over = normalizeFindings([rawFinding({ confidence: 2.5 })], "r", DIFF);
    expect(over[0].confidence).toBe(1);
    const under = normalizeFindings([rawFinding({ confidence: -0.5 })], "r", DIFF);
    expect(under[0].confidence).toBe(0);
    const nan = normalizeFindings([rawFinding({ confidence: Number.NaN })], "r", DIFF);
    expect(nan[0].confidence).toBe(0.5);
    const str = normalizeFindings(
      [{ ...rawFinding(), confidence: "high" as unknown as number }],
      "r",
      DIFF,
    );
    expect(str[0].confidence).toBe(0.5);
  });

  it("drops findings with an empty message", () => {
    const out = normalizeFindings(
      [rawFinding({ message: "   " }), rawFinding({ message: "real" })],
      "r",
      DIFF,
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("real");
  });

  it("resolves a drifted line within ±3 to the nearest added line", () => {
    // Added lines in src/auth.ts are 3 and 4 (hunk starts at new line 1:
    // context(1), context(2), +TODO(3), +if pw(4), context(5), context(6), context(7)).
    const out = normalizeFindings([rawFinding({ line: 6 })], "r", DIFF);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(4); // nearest added line within ±3
  });

  it("sets line to null when the cited line is far from any added line", () => {
    const out = normalizeFindings([rawFinding({ line: 100 })], "r", DIFF);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBeNull();
    expect(out[0].file).toBe("src/auth.ts"); // file itself is kept
  });

  it("sets line to null when the file is not in the diff at all", () => {
    const out = normalizeFindings([rawFinding({ file: "src/other.ts", line: 3 })], "r", DIFF);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("src/other.ts");
    expect(out[0].line).toBeNull();
  });

  it("sets line to null for non-positive line numbers", () => {
    const zero = normalizeFindings([rawFinding({ line: 0 })], "r", DIFF);
    expect(zero[0].line).toBeNull();
    const neg = normalizeFindings([rawFinding({ line: -5 })], "r", DIFF);
    expect(neg[0].line).toBeNull();
  });

  it("keeps a null line as null", () => {
    const out = normalizeFindings([rawFinding({ line: null })], "r", DIFF);
    expect(out[0].line).toBeNull();
  });

  it("trims remediation and omits it when empty", () => {
    const withRem = normalizeFindings([rawFinding({ remediation: "  fix it  " })], "r", DIFF);
    expect(withRem[0].remediation).toBe("fix it");
    const emptyRem = normalizeFindings([rawFinding({ remediation: "   " })], "r", DIFF);
    expect(emptyRem[0].remediation).toBeUndefined();
  });
});

describe("dedupeFindings", () => {
  it("merges near-duplicate findings across two reviewers, keeping higher confidence", () => {
    const a = finding({
      reviewer: "reviewer-a",
      confidence: 0.6,
      message: "Hardcoded password hunter2 grants admin access",
    });
    const b = finding({
      reviewer: "reviewer-b",
      confidence: 0.9,
      message: "hardcoded password  hunter2  grants admin access!",
    });
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].reviewer).toBe("reviewer-b");
    expect(out[0].confidence).toBe(0.9);
  });

  it("merges findings on adjacent lines (±2)", () => {
    const a = finding({ reviewer: "a", line: 3, message: "same issue here", confidence: 0.7 });
    const b = finding({ reviewer: "b", line: 5, message: "same issue here", confidence: 0.8 });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it("merges when one message contains the other", () => {
    const a = finding({ reviewer: "a", message: "SQL injection", confidence: 0.5 });
    const b = finding({ reviewer: "b", message: "SQL injection in the login query string", confidence: 0.6 });
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.6);
  });

  it("does not merge findings in different files", () => {
    const a = finding({ reviewer: "a", file: "x.ts", message: "bad thing" });
    const b = finding({ reviewer: "b", file: "y.ts", message: "bad thing" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("does not merge findings with different severities", () => {
    const a = finding({ reviewer: "a", severity: "high", message: "bad thing" });
    const b = finding({ reviewer: "b", severity: "low", message: "bad thing" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("does not merge findings on distant lines", () => {
    const a = finding({ reviewer: "a", line: 3, message: "bad thing" });
    const b = finding({ reviewer: "b", line: 30, message: "bad thing" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("does not merge dissimilar messages", () => {
    const a = finding({ reviewer: "a", message: "missing null check on user input" });
    const b = finding({ reviewer: "b", message: "rename variable for readability" });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("merges two null-line findings with similar messages", () => {
    const a = finding({ reviewer: "a", line: null, message: "auth is weak", confidence: 0.5 });
    const b = finding({ reviewer: "b", line: null, message: "auth is weak", confidence: 0.7 });
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].reviewer).toBe("b");
  });

  it("dedupes within a single reviewer's list", () => {
    const a = finding({ reviewer: "a", message: "duplicate issue", confidence: 0.5 });
    const b = finding({ reviewer: "a", message: "duplicate issue", confidence: 0.4 });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });
});

describe("mergeJuryFindings", () => {
  it("unions findings across reviewers and dedupes", () => {
    const r1 = [
      finding({ reviewer: "r1", message: "shared issue", confidence: 0.6 }),
      finding({ reviewer: "r1", message: "unique to r1", confidence: 0.7 }),
    ];
    const r2 = [
      finding({ reviewer: "r2", message: "shared issue", confidence: 0.9 }),
      finding({ reviewer: "r2", message: "unique to r2", confidence: 0.5 }),
    ];
    const out = mergeJuryFindings([r1, r2]);
    expect(out).toHaveLength(3);
    const shared = out.find((f) => f.message === "shared issue");
    expect(shared?.reviewer).toBe("r2");
  });

  it("handles empty juries", () => {
    expect(mergeJuryFindings([])).toEqual([]);
    expect(mergeJuryFindings([[], []])).toEqual([]);
  });
});

describe("end to end: parse → normalize", () => {
  it("turns a canned reviewer response into canonical findings", () => {
    const raw = parseReviewResponse(VALID_RESPONSE, "claude-opus-4-6");
    const findings = normalizeFindings(raw, "claude-opus-4-6", DIFF);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      severity: "critical",
      file: "src/auth.ts",
      line: 4,
      category: "security",
      reviewer: "claude-opus-4-6",
    });
    expect(findings[1].line).toBeNull();
  });
});
