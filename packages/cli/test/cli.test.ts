// Tests for the noselfgrade CLI (component e).
//
// Only the dispatch layer is mocked (no HTTP, no network): dispatchReview
// and the single repair pass are faked. Everything else — parsing,
// normalization, merging, verdict, certification, rendering — is the real
// core. Signing tests use real Ed25519 keypairs under a temp HOME.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runReviewPipeline,
  runInit,
  runKeygen,
  verifyCertificateFile,
  loadConfig,
  familiesTable,
  buildBindings,
  CliError,
  defaultDeps,
  type ReviewDeps,
  type ReviewOptions,
} from "../src/index";
import {
  buildReportBody,
  signReport,
  keyIdFor,
} from "@tamtunnel/noselfgrade-core/dist/certify.js";

// ── Fixtures ──────────────────────────────────────────────────────────────
const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
 export function login(user: string) {
+  const token = "hardcoded-secret";
+  console.log(token);
   return true;
 }
`;

const CANNED_EMPTY = JSON.stringify({ findings: [] });

const CANNED_HIGH = JSON.stringify({
  findings: [
    {
      severity: "high",
      file: "src/auth.ts",
      line: 2,
      category: "security",
      confidence: 0.9,
      message: "Hardcoded secret is logged to the console",
      remediation: "Remove the hardcoded token; load it from the environment",
      snippet: 'const token = "hardcoded-secret";',
    },
  ],
});

const CANNED_MEDIUM = JSON.stringify({
  findings: [
    {
      severity: "medium",
      file: "src/auth.ts",
      line: 3,
      category: "style",
      confidence: 0.6,
      message: "Debug console.log left in the diff",
    },
  ],
});

const BROKEN = "this is not json at all, just prose";

const FAKE_REVIEWERS = [
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKeyFingerprint: "sha256:fakefingerprint",
  },
];

function fakeDeps(rawText: string, repairText?: string): ReviewDeps {
  return {
    ...defaultDeps,
    dispatchReview: async () => ({
      reviewers: FAKE_REVIEWERS,
      rawResponses: [{ reviewer: "anthropic:claude-sonnet-4-5", text: rawText }],
    }),
    repairReview: async () => repairText ?? rawText,
  };
}

let tmp = "";
let diffPath = "";

function baseOpts(overrides: Partial<ReviewOptions> = {}): ReviewOptions {
  return {
    diffFile: "change.diff",
    staged: false,
    builderModel: "gpt-5",
    builderProvider: "openai",
    allowUnknownModel: false,
    jury: false,
    failOn: "high",
    format: "markdown",
    output: "report.md",
    timeoutSec: 120,
    noSign: true,
    cwd: tmp,
    env: { ANTHROPIC_API_KEY: "test-key" },
    ...overrides,
  };
}

const origHome = process.env.HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nsg-cli-test-"));
  diffPath = join(tmp, "change.diff");
  writeFileSync(diffPath, DIFF, "utf8");
  process.env.HOME = mkdtempSync(join(tmpdir(), "nsg-cli-home-"));
});

afterEach(() => {
  const home = process.env.HOME;
  process.env.HOME = origHome;
  if (home && home.includes("nsg-cli-home-")) rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

// ── init ──────────────────────────────────────────────────────────────────
describe("init", () => {
  it("writes a starter .noselfgrade.json", () => {
    const path = runInit(tmp, false);
    expect(existsSync(path)).toBe(true);
    const cfg = loadConfig(tmp);
    expect(cfg.builderModel).toBe("gpt-5");
    expect(cfg.builderProvider).toBe("openai");
    expect(cfg.failOn).toBe("high");
    expect(cfg.format).toBe("markdown");
    expect(cfg.jury).toBe(false);
  });

  it("refuses to clobber without --force", () => {
    runInit(tmp, false);
    expect(() => runInit(tmp, false)).toThrowError(CliError);
    expect(() => runInit(tmp, false)).toThrowError(/already exists/);
  });

  it("overwrites with --force", () => {
    runInit(tmp, false);
    writeFileSync(join(tmp, ".noselfgrade.json"), '{"custom": true}', "utf8");
    runInit(tmp, true);
    expect(loadConfig(tmp)).not.toHaveProperty("custom");
  });

  it("loadConfig returns {} when no config file exists", () => {
    expect(loadConfig(join(tmp, "empty-subdir"))).toEqual({});
  });
});

// ── keygen ────────────────────────────────────────────────────────────────
describe("keygen", () => {
  it("writes a keypair to the temp HOME and prints paths + keyId", () => {
    const res = runKeygen(false);
    expect(existsSync(res.privateKeyPath)).toBe(true);
    expect(existsSync(res.publicKeyPath)).toBe(true);
    expect(res.keyId).toBe(keyIdFor(readFileSync(res.publicKeyPath, "utf8")));
    expect(res.keyId).toMatch(/^keyid:[0-9a-f]{16}$/);
  });

  it("refuses to clobber without --force", () => {
    runKeygen(false);
    expect(() => runKeygen(false)).toThrowError(CliError);
    expect(() => runKeygen(false)).toThrowError(/already exists/);
  });

  it("overwrites with --force", () => {
    const first = runKeygen(false);
    const second = runKeygen(true);
    expect(second.keyId).not.toBe(first.keyId);
  });
});

// ── verify ────────────────────────────────────────────────────────────────
describe("verify", () => {
  it("accepts a certificate signed in-test", () => {
    const { publicKeyPath } = runKeygen(false);
    const report = buildReportBody({
      diff: DIFF,
      declaredBuilder: { model: "gpt-5", provider: "openai" },
      reviewers: FAKE_REVIEWERS,
      findings: [],
      verdict: "PASS",
    });
    // Sign with the on-disk private key so verify uses the public key file.
    const { loadKeypair } = defaultDeps;
    const onDisk = loadKeypair();
    const cert = signReport(report, onDisk.privateKey);
    const certPath = join(tmp, "cert.json");
    writeFileSync(certPath, JSON.stringify(cert), "utf8");

    const out = verifyCertificateFile(certPath, publicKeyPath);
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it("rejects a tampered certificate", () => {
    const { publicKeyPath } = runKeygen(false);
    const onDisk = defaultDeps.loadKeypair();
    const report = buildReportBody({
      diff: DIFF,
      declaredBuilder: { model: "gpt-5", provider: "openai" },
      reviewers: FAKE_REVIEWERS,
      findings: [],
      verdict: "PASS",
    });
    const cert = signReport(report, onDisk.privateKey);
    cert.report.verdict = "FAIL"; // tamper after signing
    const certPath = join(tmp, "cert.json");
    writeFileSync(certPath, JSON.stringify(cert), "utf8");

    const out = verifyCertificateFile(certPath, publicKeyPath);
    expect(out.valid).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("uses ~/.noselfgrade/id_ed25519.pub by default", () => {
    runKeygen(false);
    const onDisk = defaultDeps.loadKeypair();
    const report = buildReportBody({
      diff: DIFF,
      declaredBuilder: { model: "gpt-5", provider: "openai" },
      reviewers: FAKE_REVIEWERS,
      findings: [],
      verdict: "PASS",
    });
    const cert = signReport(report, onDisk.privateKey);
    const certPath = join(tmp, "cert.json");
    writeFileSync(certPath, JSON.stringify(cert), "utf8");
    expect(verifyCertificateFile(certPath).valid).toBe(true);
  });

  it("exit-2 on a missing certificate file", () => {
    expect(() => verifyCertificateFile(join(tmp, "nope.json"))).toThrowError(
      expect.objectContaining({ exitCode: 2 }),
    );
  });
});

// ── review pipeline ───────────────────────────────────────────────────────
describe("review pipeline", () => {
  it("writes markdown and exits 0 on PASS", async () => {
    const res = await runReviewPipeline(baseOpts(), fakeDeps(CANNED_EMPTY));
    expect(res.exitCode).toBe(0);
    expect(res.verdict).toBe("PASS");
    expect(res.findings).toEqual([]);
    expect(res.signed).toBe(false); // noSign in baseOpts
    const out = readFileSync(join(tmp, "report.md"), "utf8");
    expect(out).toContain("PASS");
    expect(res.rendered).toBe(out);
  });

  it("exits 1 on FAIL when a high finding meets the threshold", async () => {
    const res = await runReviewPipeline(baseOpts(), fakeDeps(CANNED_HIGH));
    expect(res.exitCode).toBe(1);
    expect(res.verdict).toBe("FAIL");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].severity).toBe("high");
    expect(res.findings[0].reviewer).toBe("claude-sonnet-4-5");
  });

  it("respects --fail-on: high finding passes when fail-on is critical", async () => {
    const res = await runReviewPipeline(
      baseOpts({ failOn: "critical" }),
      fakeDeps(CANNED_HIGH),
    );
    expect(res.exitCode).toBe(0);
    expect(res.verdict).toBe("PASS");
  });

  it("signs the certificate when a key exists", async () => {
    runKeygen(false);
    const res = await runReviewPipeline(baseOpts({ noSign: false }), fakeDeps(CANNED_EMPTY));
    expect(res.signed).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it("exit 2 when no signing key exists and --no-sign is not passed", async () => {
    await expect(
      runReviewPipeline(baseOpts({ noSign: false }), fakeDeps(CANNED_EMPTY)),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("exit 2 on a missing diff file", async () => {
    await expect(
      runReviewPipeline(baseOpts({ diffFile: "does-not-exist.diff" }), fakeDeps(CANNED_EMPTY)),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("exit 2 on an unknown builder model with an actionable message", async () => {
    const err = await runReviewPipeline(
      baseOpts({ builderModel: "definitely-not-a-model-xyz" }),
      fakeDeps(CANNED_EMPTY),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ exitCode: 2 });
    expect((err as Error).message).toContain("family table");
  });

  it("exit 2 when no API keys are configured, listing the env vars", async () => {
    const err = await runReviewPipeline(
      baseOpts({ env: {} }),
      fakeDeps(CANNED_EMPTY),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ exitCode: 2 });
    expect((err as Error).message).toContain("ANTHROPIC_API_KEY");
  });

  it("repair path: broken first response, repaired on retry → findings present", async () => {
    const res = await runReviewPipeline(
      baseOpts(),
      fakeDeps(BROKEN, CANNED_MEDIUM),
    );
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].severity).toBe("medium");
    expect(res.exitCode).toBe(0); // medium < high threshold
  });

  it("exit 2 naming the reviewer when the repair pass also fails", async () => {
    const err = await runReviewPipeline(
      baseOpts(),
      fakeDeps(BROKEN, BROKEN),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ exitCode: 2 });
    expect((err as Error).message).toContain("anthropic:claude-sonnet-4-5");
  });

  it("propagates dispatch errors as exit 2", async () => {
    const deps: ReviewDeps = {
      ...fakeDeps(CANNED_EMPTY),
      dispatchReview: async () => {
        const { DispatchError } = await import(
          "@tamtunnel/noselfgrade-core/dist/dispatch.js"
        );
        throw new DispatchError("no disjoint reviewer available");
      },
    };
    await expect(runReviewPipeline(baseOpts(), deps)).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});

// ── bindings & families ───────────────────────────────────────────────────
describe("bindings", () => {
  it("builds one binding per configured API key with the default model", () => {
    const bindings = buildBindings({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
    });
    expect(bindings.get("anthropic")?.model).toBe("claude-sonnet-4-5");
    expect(bindings.get("openai")?.model).toBe("gpt-5");
    expect(bindings.get("anthropic")?.apiKey).toBe("a");
  });

  it("returns an empty map when no keys are set", () => {
    expect(buildBindings({}).size).toBe(0);
  });
});

describe("families", () => {
  it("prints the family table", () => {
    const table = familiesTable();
    expect(table).toContain("MODEL");
    expect(table).toContain("claude-sonnet-4-5");
    expect(table).toContain("gpt-5");
    expect(table).toContain("anthropic");
  });
});
