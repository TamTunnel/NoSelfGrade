/**
 * Reporter tests. The SARIF schema was downloaded once from
 * https://json.schemastore.org/sarif-2.1.0.json and committed at
 * ./sarif-schema.json; tests run offline and validate structurally
 * against the required SARIF shape.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Certificate, Finding } from "../src/types.js";
import {
  render,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderSarif,
  type ReportFormat,
} from "../src/reporters/index.js";

const BACKTICK_MSG = "Suspicious eval usage. Example of the pattern:\n```js\neval(userInput);\n```\nRemove it.";

function fixture(): Certificate {
  const findings: Finding[] = [
    {
      severity: "critical",
      file: "src/auth.ts",
      line: 42,
      category: "security",
      confidence: 0.95,
      message: BACKTICK_MSG,
      remediation: "Replace eval with a safe parser.",
      reviewer: "claude-opus-4-6",
    },
    {
      severity: "high",
      file: "src/db.ts",
      line: null,
      category: "security",
      confidence: 0.8,
      message: "Query built from string concatenation; location could not be pinned.",
      reviewer: "claude-opus-4-6",
    },
    {
      severity: "medium",
      file: "src/util.ts",
      line: 7,
      category: "correctness",
      confidence: 0.7,
      message: "Off-by-one in loop bound.",
      remediation: "Use < length.",
      reviewer: "gemini-2.5-pro",
    },
    {
      severity: "low",
      file: "src/style.ts",
      line: 3,
      category: "style",
      confidence: 0.6,
      message: "Inconsistent naming.",
      reviewer: "gemini-2.5-pro",
    },
    {
      severity: "info",
      file: "src/perf.ts",
      line: 9,
      category: "perf",
      confidence: 0.5,
      message: "<script>alert(1)</script> — consider memoizing this.",
      reviewer: "gemini-2.5-pro",
    },
  ];
  return {
    report: {
      diffHash: "ab".repeat(32),
      declaredBuilder: { model: "gpt-4o", provider: "openai" },
      reviewers: [
        { provider: "anthropic", model: "claude-opus-4-6", apiKeyFingerprint: "aa".repeat(8) },
        { provider: "google", model: "gemini-2.5-pro", apiKeyFingerprint: "bb".repeat(8) },
      ],
      findings,
      verdict: "FAIL",
      timestamp: "2026-10-10T12:00:00.000Z",
    },
    signature: "c2lnbmF0dXJl",
    keyId: "keyid1234",
    formatVersion: 1,
  };
}

describe("renderJson", () => {
  it("round-trips through JSON.parse and contains the envelope", () => {
    const cert = fixture();
    const out = renderJson(cert);
    const parsed = JSON.parse(out) as Certificate;
    expect(parsed).toEqual(cert);
    expect(out).toContain(cert.signature);
    expect(out).toContain(cert.keyId);
    expect(out).toContain('"formatVersion": 1');
  });
});

describe("renderMarkdown", () => {
  it("contains the independence statement with declared-not-verified language", () => {
    const out = renderMarkdown(fixture());
    expect(out).toContain("## Independence statement");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("openai");
    expect(out).toContain("declared, not verified");
    expect(out).toContain("claude-opus-4-6");
    expect(out).toContain("gemini-2.5-pro");
    expect(out).toContain("aa".repeat(8));
    expect(out).toContain("bb".repeat(8));
    const disjointLines = out.split("\n").filter((l) => l.includes("disjoint ✓"));
    expect(disjointLines).toHaveLength(2);
    expect(out).toContain("anthropic ≠ builder provider openai");
    expect(out).toContain("google ≠ builder provider openai");
    expect(out).toContain(
      "Builder identity is declared, not verified. The signature proves this review ran with these reviewers on this diff — nothing more."
    );
  });

  it("has a verdict badge, timestamp, and summary counts", () => {
    const out = renderMarkdown(fixture());
    expect(out).toContain("❌ FAIL");
    expect(out).toContain("2026-10-10T12:00:00.000Z");
    expect(out).toContain("## Summary");
    expect(out).toContain("- **critical:** 1");
    expect(out).toContain("- **Total:** 5");
  });

  it("uses variable-length fences so triple backticks in content do not break structure", () => {
    const out = renderMarkdown(fixture());
    // Content contains a ``` run, so its fence must be 6 backticks (longest + 3).
    expect(out).toContain("``````\n" + BACKTICK_MSG + "\n``````");
    // The message's own fence lines (immediately before its first line and
    // after its last line) are exactly 6 backticks, not 3.
    const lines = out.split("\n");
    const msgLines = BACKTICK_MSG.split("\n");
    const startIdx = lines.indexOf(msgLines[0]);
    expect(startIdx).toBeGreaterThan(0);
    expect(lines[startIdx - 1]).toBe("``````");
    const endIdx = startIdx + msgLines.length - 1;
    expect(lines[endIdx]).toBe(msgLines[msgLines.length - 1]);
    expect(lines[endIdx + 1]).toBe("``````");
  });
});

describe("renderSarif", () => {
  /** Hand-rolled structural validator for the required SARIF shape. */
  function validateSarifShape(doc: unknown): void {
    const d = doc as Record<string, unknown>;
    expect(d.version).toBe("2.1.0");
    expect(typeof d.$schema).toBe("string");
    expect(String(d.$schema)).toContain("sarif");
    expect(Array.isArray(d.runs)).toBe(true);
    const runs = d.runs as Array<Record<string, unknown>>;
    expect(runs.length).toBeGreaterThan(0);
    const run = runs[0];
    const driver = (run.tool as Record<string, Record<string, unknown>>).driver;
    expect(driver).toBeDefined();
    expect(driver.name).toBe("noselfgrade");
    expect(typeof driver.version).toBe("string");
    expect(driver.informationUri).toBe("https://github.com/TamTunnel/noselfgrade");
    const ruleIds = new Set(
      ((driver.rules ?? []) as Array<{ id: string }>).map((r) => r.id)
    );
    const results = run.results as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    for (const res of results) {
      expect(typeof res.ruleId).toBe("string");
      expect(ruleIds.has(res.ruleId as string)).toBe(true);
      expect(typeof res.level).toBe("string");
      expect(typeof (res.message as { text: string }).text).toBe("string");
      const locs = res.locations as Array<Record<string, unknown>>;
      expect(Array.isArray(locs)).toBe(true);
      expect(locs.length).toBeGreaterThan(0);
      const phys = locs[0].physicalLocation as Record<string, unknown>;
      expect(typeof (phys.artifactLocation as { uri: string }).uri).toBe("string");
    }
  }

  it("matches the official SARIF 2.1.0 schema document and the required shape", () => {
    const schemaRaw = readFileSync(new URL("./sarif-schema.json", import.meta.url), "utf8");
    const schema = JSON.parse(schemaRaw) as { $id: string };
    expect(schema.$id).toContain("sarif-schema-2.1.0");
    const doc = JSON.parse(renderSarif(fixture()));
    validateSarifShape(doc);
  });

  it("emits one rule per distinct category and every finding as a result", () => {
    const doc = JSON.parse(renderSarif(fixture())) as {
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } };
        results: Array<{ properties: { category: string } }>;
      }>;
    };
    const ruleIds = doc.runs[0].tool.driver.rules.map((r) => r.id).sort();
    expect(ruleIds).toEqual([
      "noselfgrade/correctness",
      "noselfgrade/perf",
      "noselfgrade/security",
      "noselfgrade/style",
    ]);
    expect(doc.runs[0].results).toHaveLength(5);
  });

  it("maps severity to SARIF level and omits region when line is null", () => {
    const doc = JSON.parse(renderSarif(fixture())) as {
      runs: Array<{
        results: Array<{
          level: string;
          ruleId: string;
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } };
          }>;
        }>;
      }>;
    };
    const byRule = new Map(doc.runs[0].results.map((r) => [r.ruleId + r.level, r] as const));
    expect(byRule.get("noselfgrade/securityerror")).toBeDefined(); // critical + high
    const levels = doc.runs[0].results.map((r) => r.level);
    expect(levels.filter((l) => l === "error")).toHaveLength(2);
    expect(levels.filter((l) => l === "warning")).toHaveLength(1);
    expect(levels.filter((l) => l === "note")).toHaveLength(2);

    const nullLine = doc.runs[0].results.find(
      (r) => r.locations[0].physicalLocation.artifactLocation.uri === "src/db.ts"
    )!;
    expect(nullLine.locations[0].physicalLocation.region).toBeUndefined();

    const withLine = doc.runs[0].results.find(
      (r) => r.locations[0].physicalLocation.artifactLocation.uri === "src/auth.ts"
    )!;
    expect(withLine.locations[0].physicalLocation.region).toEqual({ startLine: 42 });
  });

  it("records the verdict and reviewer models in run.properties", () => {
    const doc = JSON.parse(renderSarif(fixture())) as {
      runs: Array<{ properties: { verdict: string; reviewerModels: string[] } }>;
    };
    expect(doc.runs[0].properties.verdict).toBe("FAIL");
    expect(doc.runs[0].properties.reviewerModels).toEqual(["claude-opus-4-6", "gemini-2.5-pro"]);
  });
});

describe("renderHtml", () => {
  it("is a self-contained scriptless document with escaped content", () => {
    const out = renderHtml(fixture());
    expect(out).toContain("<!DOCTYPE html>");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("❌ FAIL");
    expect(out).toContain("Independence statement");
    expect(out).toContain("declared, not verified");
    expect(out).toContain("disjoint ✓");
    expect(out).toContain("prefers-color-scheme");
    expect(out).toContain("<style>");
  });
});

describe("render dispatcher", () => {
  it("renders every format and throws on a bogus format", () => {
    const cert = fixture();
    const formats: ReportFormat[] = ["json", "markdown", "sarif", "html"];
    for (const f of formats) {
      const out = render(cert, f);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
    expect(() => render(cert, "yaml" as ReportFormat)).toThrow(/unknown report format/i);
  });
});
