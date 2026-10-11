import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReportBody,
  canonicalize,
  computeVerdict,
  defaultKeyDir,
  generateKeypair,
  hashDiff,
  keyIdFor,
  loadKeypair,
  saveKeypair,
  signReport,
  verifyCertificate,
} from "../src/certify.js";
import { lookupModel } from "../src/families.js";
import type { BuilderDeclaration, Finding, ReportBody, ReviewerInfo } from "../src/types.js";

const SAMPLE_DIFF =
  "diff --git a/src/auth.ts b/src/auth.ts\nindex 0000000..1111111 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-if (token) login();\n+if (token === 'x') login();";

const CANDIDATE_MODELS = [
  "gpt-4o",
  "o3",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "gemini-2.5-pro",
];

/** Pick the first model id the family table actually knows. */
function firstKnownModel(): string {
  for (const id of CANDIDATE_MODELS) {
    if (lookupModel(id)) return id;
  }
  throw new Error("family table has none of the candidate models");
}

function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "high",
    file: "src/auth.ts",
    line: 1,
    category: "security",
    confidence: 0.9,
    message: "hardcoded token comparison",
    remediation: "use a constant-time compare",
    reviewer: "claude-opus-4-6",
    ...overrides,
  };
}

function sampleBody(overrides: Partial<ReportBody> = {}): ReportBody {
  return buildReportBody({
    diff: SAMPLE_DIFF,
    declaredBuilder: { model: "gpt-4o", provider: "openai" },
    reviewers: [{ provider: "anthropic", model: "claude-opus-4-6", apiKeyFingerprint: "abcd".repeat(4) }],
    findings: [sampleFinding()],
    verdict: "FAIL",
    ...overrides,
  });
}

function sampleReviewer(model: string): ReviewerInfo {
  return { provider: "test-provider", model, apiKeyFingerprint: "abcd".repeat(4) };
}

describe("canonicalize", () => {
  it("is stable across key insertion order, including nested objects", () => {
    const a: ReportBody = {
      verdict: "FAIL",
      diffHash: hashDiff(SAMPLE_DIFF),
      timestamp: "2026-10-10T12:00:00.000Z",
      declaredBuilder: { model: "gpt-4o", provider: "openai" },
      reviewers: [{ provider: "anthropic", model: "claude-opus-4-6", apiKeyFingerprint: "ab".repeat(8) }],
      findings: [
        {
          reviewer: "claude-opus-4-6",
          message: "hardcoded-token",
          confidence: 0.9,
          category: "security",
          line: 1,
          file: "src/auth.ts",
          severity: "high",
        },
      ],
    };
    // Same logical report, keys inserted in a different order everywhere.
    const b = {} as ReportBody;
    b.findings = [
      {
        severity: "high",
        file: "src/auth.ts",
        line: 1,
        category: "security",
        confidence: 0.9,
        message: "hardcoded-token",
        reviewer: "claude-opus-4-6",
      },
    ];
    b.timestamp = "2026-10-10T12:00:00.000Z";
    b.verdict = "FAIL";
    b.declaredBuilder = { provider: "openai", model: "gpt-4o" } as BuilderDeclaration;
    b.reviewers = [{ apiKeyFingerprint: "ab".repeat(8), model: "claude-opus-4-6", provider: "anthropic" }];
    b.diffHash = hashDiff(SAMPLE_DIFF);

    expect(canonicalize(a)).toBe(canonicalize(b));
    // compact: no formatting whitespace (spaces inside string values are fine)
    expect(canonicalize(a)).not.toContain('": "');
    expect(canonicalize(a)).not.toContain('", "');
    expect(canonicalize(a)).not.toContain("\n");
  });
});

describe("hashDiff", () => {
  it("is sha256 hex of the exact text", () => {
    expect(hashDiff("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDiff("abc")).not.toBe(hashDiff("abd"));
  });
});

describe("keypair and keyId", () => {
  it("generates PEM keys and a stable keyId", () => {
    const kp = generateKeypair();
    expect(kp.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(kp.publicKey).toContain("BEGIN PUBLIC KEY");
    const id = keyIdFor(kp.publicKey);
    expect(id).toMatch(/^keyid:[0-9a-f]{16}$/);
    expect(keyIdFor(kp.publicKey)).toBe(id);
  });
});

describe("signReport / verifyCertificate", () => {
  it("round-trips valid", () => {
    const kp = generateKeypair();
    const body = sampleBody();
    const cert = signReport(body, kp.privateKey);
    expect(cert.formatVersion).toBe(1);
    expect(cert.keyId).toBe(keyIdFor(kp.publicKey));
    const res = verifyCertificate(cert, kp.publicKey);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("rejects a tampered report (changed finding message)", () => {
    const kp = generateKeypair();
    const cert = signReport(sampleBody(), kp.privateKey);
    cert.report.findings[0].message = "everything is fine, nothing to see here";
    const res = verifyCertificate(cert, kp.publicKey);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /signature/i.test(e))).toBe(true);
  });

  it("rejects the wrong key", () => {
    const kp = generateKeypair();
    const other = generateKeypair();
    const cert = signReport(sampleBody(), kp.privateKey);
    const res = verifyCertificate(cert, other.publicKey);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it("rejects a wrong formatVersion", () => {
    const kp = generateKeypair();
    const cert = signReport(sampleBody(), kp.privateKey);
    (cert as { formatVersion: number }).formatVersion = 2;
    const res = verifyCertificate(cert, kp.publicKey);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /formatversion/i.test(e))).toBe(true);
  });

  it("rejects an unparseable timestamp and a bad verdict", () => {
    const kp = generateKeypair();
    const cert = signReport(sampleBody(), kp.privateKey);
    cert.report.timestamp = "not-a-date";
    (cert.report as { verdict: string }).verdict = "MAYBE";
    const res = verifyCertificate(cert, kp.publicKey);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /timestamp/i.test(e))).toBe(true);
    expect(res.errors.some((e) => /verdict/i.test(e))).toBe(true);
  });

  it("rejects a tampered keyId", () => {
    const kp = generateKeypair();
    const cert = signReport(sampleBody(), kp.privateKey);
    cert.keyId = "keyid:deadbeefdeadbeef";
    const res = verifyCertificate(cert, kp.publicKey);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /keyid/i.test(e))).toBe(true);
  });

  it("never throws on garbage input", () => {
    const kp = generateKeypair();
    for (const bad of [null, undefined, 42, "cert", {}, { report: null }] as never[]) {
      const res = verifyCertificate(bad, kp.publicKey);
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
    }
    // garbage public key: still a result, not a throw
    const cert = signReport(sampleBody(), kp.privateKey);
    const res = verifyCertificate(cert, "not-a-pem");
    expect(res.valid).toBe(false);
  });
});

describe("disjointness re-validation", () => {
  it("fails when a reviewer shares the builder's family", () => {
    const model = firstKnownModel();
    const kp = generateKeypair();
    const cert = signReport(
      sampleBody({
        declaredBuilder: { model, provider: "declared-provider" },
        reviewers: [sampleReviewer(model)],
      }),
      kp.privateKey,
    );
    const res = verifyCertificate(cert, kp.publicKey);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /disjoint/i.test(e))).toBe(true);
  });

  it("errors on an unknown builder model instead of passing silently", () => {
    const kp = generateKeypair();
    const cert = signReport(
      sampleBody({
        declaredBuilder: { model: "no-such-model-zzz-123", provider: "nowhere" },
        reviewers: [sampleReviewer(firstKnownModel())],
      }),
      kp.privateKey,
    );
    const res = verifyCertificate(cert, kp.publicKey);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => /family table/i.test(e) && /no-such-model-zzz-123/.test(e)),
    ).toBe(true);
  });
});

describe("buildReportBody", () => {
  it("sets diffHash from the diff and a parseable timestamp", () => {
    const body = sampleBody();
    expect(body.diffHash).toBe(hashDiff(SAMPLE_DIFF));
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });
});

describe("computeVerdict", () => {
  it("fails on findings at or above the threshold, passes below", () => {
    const high = [sampleFinding({ severity: "high" })];
    const medium = [sampleFinding({ severity: "medium" })];
    expect(computeVerdict(high, "high")).toBe("FAIL");
    expect(computeVerdict([sampleFinding({ severity: "critical" })], "high")).toBe("FAIL");
    expect(computeVerdict(medium, "high")).toBe("PASS");
    expect(computeVerdict(medium, "medium")).toBe("FAIL");
    expect(computeVerdict([], "critical")).toBe("PASS");
    // failOn critical: only critical fails
    expect(computeVerdict(high, "critical")).toBe("PASS");
  });
});

describe("key management", () => {
  it("defaultKeyDir is ~/.noselfgrade", () => {
    expect(defaultKeyDir()).toBe(join(process.env.HOME ?? "", ".noselfgrade"));
  });

  it("saveKeypair writes with safe modes and refuses to clobber", () => {
    const dir = mkdtempSync(join(tmpdir(), "nsg-keys-"));
    const kp = generateKeypair();
    const saved = saveKeypair(dir, kp);
    expect(saved.privateKeyPath).toBe(join(dir, "id_ed25519"));
    expect(saved.publicKeyPath).toBe(join(dir, "id_ed25519.pub"));
    expect(readFileSync(saved.privateKeyPath, "utf8")).toBe(kp.privateKey);
    expect(readFileSync(saved.publicKeyPath, "utf8")).toBe(kp.publicKey);
    expect(statSync(saved.privateKeyPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    expect(() => saveKeypair(dir, kp)).toThrow(/refusing to overwrite/i);

    // round-trip through loadKeypair
    const loaded = loadKeypair(dir);
    expect(loaded.privateKey).toBe(kp.privateKey);
    expect(loaded.publicKey).toBe(kp.publicKey);
  });

  it("saveKeypair writes nothing when it refuses to clobber", () => {
    const dir = mkdtempSync(join(tmpdir(), "nsg-keys-"));
    const kp = generateKeypair();
    saveKeypair(dir, kp);
    const before = readFileSync(join(dir, "id_ed25519"), "utf8");
    expect(() => saveKeypair(dir, generateKeypair())).toThrow();
    expect(readFileSync(join(dir, "id_ed25519"), "utf8")).toBe(before);
  });

  it("loadKeypair errors helpfully when keys are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nsg-empty-"));
    expect(() => loadKeypair(dir)).toThrow(/noselfgrade keygen/);
    // partial keypair is still an error
    writeFileSync(join(dir, "id_ed25519.pub"), "x");
    expect(() => loadKeypair(dir)).toThrow(/id_ed25519/);
  });
});
