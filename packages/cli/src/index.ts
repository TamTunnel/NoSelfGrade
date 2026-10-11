#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// noselfgrade — CLI
//
//   review [diff]          Review a diff with reviewers disjoint in family and
//                          provider from the DECLARED builder; emit a signed
//                          certificate (JSON/Markdown/SARIF/HTML).
//   verify <certificate>  Verify a signed certificate offline.
//   keygen                 Generate an Ed25519 signing keypair (~/.noselfgrade).
//   init                   Write a starter .noselfgrade.json in cwd.
//   families list          Print the curated model family table.
//
// Exit codes: 0 = verdict PASS · 1 = verdict FAIL · 2 = config/usage/provider
// error (including malformed reviewer output that survives the repair pass).
//
// The builder declaration is UNTRUSTED input: it is recorded verbatim as
// *declared* and used only for reviewer selection — never injected into the
// review prompt. See ARCHITECTURE.md §2.
// ═══════════════════════════════════════════════════════════════════════════

// ── Section 1: imports ─────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { defineCommand, runMain } from "citty";

// Core engine. Deep subpath imports resolve to packages/core/dist at runtime
// (workspace symlink + "./dist/*" export) and typecheck against the same.
import {
  parseBuilderDeclaration,
  BuilderError,
} from "@tamtunnel/noselfgrade-core/dist/builder.js";
import { listModels } from "@tamtunnel/noselfgrade-core/dist/families.js";
import { hashDiff } from "@tamtunnel/noselfgrade-core/dist/certify.js";
import {
  dispatchReview,
  DispatchError,
  REVIEW_ENV_VARS,
  DEFAULT_REVIEWERS,
  resolveTransport,
} from "@tamtunnel/noselfgrade-core/dist/dispatch.js";
import type {
  ProviderBinding,
  DispatchResult,
} from "@tamtunnel/noselfgrade-core/dist/dispatch.js";
import { getProvider } from "@tamtunnel/noselfgrade-core/dist/providers/types.js";
import {
  buildReviewPrompt,
  buildRepairPrompt,
} from "@tamtunnel/noselfgrade-core/dist/prompts.js";
import {
  parseReviewResponse,
  normalizeFindings,
  mergeJuryFindings,
  FindingParseError,
} from "@tamtunnel/noselfgrade-core/dist/findings.js";
import type { RawFinding } from "@tamtunnel/noselfgrade-core/dist/findings.js";
import {
  buildReportBody,
  signReport,
  verifyCertificate,
  computeVerdict,
  generateKeypair,
  saveKeypair,
  loadKeypair,
  defaultKeyDir,
  keyIdFor,
} from "@tamtunnel/noselfgrade-core/dist/certify.js";
import type { Keypair } from "@tamtunnel/noselfgrade-core/dist/certify.js";
import { render } from "@tamtunnel/noselfgrade-core/dist/reporters/index.js";
import type { ReportFormat } from "@tamtunnel/noselfgrade-core/dist/reporters/index.js";
import type {
  BuilderDeclaration,
  Certificate,
  Finding,
  ReviewerInfo,
  Severity,
  Verdict,
} from "@tamtunnel/noselfgrade-core/dist/types.js";
import { SEVERITIES } from "@tamtunnel/noselfgrade-core/dist/types.js";

// ── Section 2: constants & errors ──────────────────────────────────────────
const require = createRequire(import.meta.url);
const VERSION: string = (require("../package.json") as { version: string }).version;

export const CONFIG_FILE = ".noselfgrade.json";
const REPORT_FORMATS: readonly ReportFormat[] = ["json", "markdown", "sarif", "html"];

/** Carries the process exit code: 2 = usage/config/provider error. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

// ── Section 3: config file ─────────────────────────────────────────────────
// Precedence: CLI flags > NOSELFGRADE_* env > .noselfgrade.json > defaults.
export interface FileConfig {
  builderModel?: string;
  builderProvider?: string;
  jury?: boolean;
  failOn?: string;
  format?: string;
  allowUnknownModel?: boolean;
}

export function loadConfig(cwd: string): FileConfig {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (err) {
    throw new CliError(
      `cannot parse ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }
}

// ── Section 4: diff acquisition ────────────────────────────────────────────
export function readDiffFile(path: string): string {
  if (!existsSync(path)) {
    throw new CliError(`diff file not found: ${path}`, 2);
  }
  const text = readFileSync(path, "utf8");
  if (!text.trim()) {
    throw new CliError(`diff is empty: ${path} — nothing to review`, 2);
  }
  return text;
}

export interface GitDiffOptions {
  staged: boolean;
  base?: string;
}

/** Run `git diff` in cwd. Injectable (deps) so tests never shell out. */
export function gitDiff(
  opts: GitDiffOptions,
  cwd: string,
  exec: typeof execFileSync = execFileSync,
): string {
  const gitArgs = ["diff", "--no-color"];
  if (opts.staged) gitArgs.push("--staged");
  else if (opts.base) gitArgs.push(opts.base);
  else gitArgs.push("HEAD");
  let out: string;
  try {
    out = exec("git", gitArgs, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }) as string;
  } catch (err) {
    throw new CliError(
      `git diff failed: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }
  if (!out.trim()) {
    throw new CliError("git diff produced an empty diff — nothing to review", 2);
  }
  return out;
}

// ── Section 5: reviewer bindings ───────────────────────────────────────────
// One binding per provider identity with a configured API key, using the
// default reviewer model for that provider from DEFAULT_REVIEWERS.
export function buildBindings(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, ProviderBinding> {
  const bindings = new Map<string, ProviderBinding>();
  for (const [providerIdentity, envVar] of Object.entries(REVIEW_ENV_VARS)) {
    const apiKey = env[envVar];
    if (!apiKey) continue;
    const candidate = DEFAULT_REVIEWERS.find((c) => c.provider === providerIdentity);
    if (!candidate) {
      console.error(
        `noselfgrade: no default reviewer for provider "${providerIdentity}" — ignoring ${envVar}`,
      );
      continue;
    }
    bindings.set(providerIdentity, {
      provider: getProvider(resolveTransport(candidate)),
      apiKey,
      model: candidate.model,
      baseUrl: candidate.baseUrl,
    });
  }
  return bindings;
}

// ── Section 6: dependency seam (injectable for tests) ──────────────────────
export interface RepairReviewInput {
  binding: ProviderBinding;
  prompt: string;
  timeoutMs: number;
}

export interface ReviewDeps {
  dispatchReview: typeof dispatchReview;
  /** Re-invoke one reviewer's provider for the single repair pass. */
  repairReview: (input: RepairReviewInput) => Promise<string>;
  parseReviewResponse: typeof parseReviewResponse;
  normalizeFindings: typeof normalizeFindings;
  mergeJuryFindings: typeof mergeJuryFindings;
  buildReviewPrompt: typeof buildReviewPrompt;
  buildRepairPrompt: typeof buildRepairPrompt;
  computeVerdict: typeof computeVerdict;
  buildReportBody: typeof buildReportBody;
  signReport: typeof signReport;
  loadKeypair: typeof loadKeypair;
  render: typeof render;
  gitDiff: typeof gitDiff;
}

/** Default repair: re-call the same reviewer's provider with the repair prompt. */
async function defaultRepairReview(input: RepairReviewInput): Promise<string> {
  return input.binding.provider.review({
    model: input.binding.model,
    prompt: input.prompt,
    apiKey: input.binding.apiKey,
    timeoutMs: input.timeoutMs,
    baseUrl: input.binding.baseUrl,
  });
}

export const defaultDeps: ReviewDeps = {
  dispatchReview,
  repairReview: defaultRepairReview,
  parseReviewResponse,
  normalizeFindings,
  mergeJuryFindings,
  buildReviewPrompt,
  buildRepairPrompt,
  computeVerdict,
  buildReportBody,
  signReport,
  loadKeypair,
  render,
  gitDiff,
};

// ── Section 7: review pipeline ─────────────────────────────────────────────
export interface ReviewOptions {
  diffFile?: string;
  staged: boolean;
  base?: string;
  builderModel?: string;
  builderProvider?: string;
  allowUnknownModel: boolean;
  jury: boolean;
  failOn: Severity;
  format: ReportFormat;
  output?: string;
  timeoutSec: number;
  noSign: boolean;
  cwd: string;
  /** Defaults to process.env; injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

export interface ReviewResult {
  exitCode: number;
  verdict: Verdict;
  findings: Finding[];
  reviewers: ReviewerInfo[];
  rendered: string;
  outputPath?: string;
  signed: boolean;
}

/**
 * Parse one reviewer's raw response, with ONE repair attempt on
 * FindingParseError. A reviewer that is still malformed after the repair
 * pass is a loud exit-2 error — reviewers are never silently dropped.
 */
async function parseOrRepair(
  deps: ReviewDeps,
  bindings: Map<string, ProviderBinding>,
  reviewerLabel: string,
  rawText: string,
  timeoutMs: number,
): Promise<RawFinding[]> {
  // dispatchReview labels raw responses "<provider>:<model>".
  const sep = reviewerLabel.indexOf(":");
  const model = sep === -1 ? reviewerLabel : reviewerLabel.slice(sep + 1);
  let parseError: FindingParseError;
  try {
    return deps.parseReviewResponse(rawText, model);
  } catch (err) {
    if (!(err instanceof FindingParseError)) throw err;
    parseError = err;
  }
  const providerIdentity = sep === -1 ? "" : reviewerLabel.slice(0, sep);
  const binding = bindings.get(providerIdentity);
  if (!binding) {
    throw new CliError(
      `reviewer "${reviewerLabel}" returned malformed findings and no provider ` +
        `binding is available for a repair pass — failing loudly rather than ` +
        `dropping the reviewer`,
      2,
    );
  }
  let repaired: string;
  try {
    repaired = await deps.repairReview({
      binding,
      prompt: deps.buildRepairPrompt(rawText, parseError.message),
      timeoutMs,
    });
  } catch (repairErr) {
    throw new CliError(
      `reviewer "${reviewerLabel}" returned malformed findings and the repair ` +
        `pass failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`,
      2,
    );
  }
  try {
    return deps.parseReviewResponse(repaired, model);
  } catch (err2) {
    throw new CliError(
      `reviewer "${reviewerLabel}" returned malformed findings even after a ` +
        `repair pass: ${err2 instanceof Error ? err2.message : String(err2)}`,
      2,
    );
  }
}

export async function runReviewPipeline(
  opts: ReviewOptions,
  deps: ReviewDeps = defaultDeps,
): Promise<ReviewResult> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutSec * 1000;

  // 1. Diff: explicit file wins; otherwise git.
  const diff = opts.diffFile
    ? readDiffFile(resolve(opts.cwd, opts.diffFile))
    : deps.gitDiff({ staged: opts.staged, base: opts.base }, opts.cwd);

  // 2. Builder declaration — untrusted, validated against the family table.
  let builder: BuilderDeclaration;
  try {
    builder = parseBuilderDeclaration({
      model: opts.builderModel,
      provider: opts.builderProvider,
      allowUnknownModel: opts.allowUnknownModel,
    });
  } catch (err) {
    if (err instanceof BuilderError) throw new CliError(err.message, 2);
    throw err;
  }
  if (builder.family === null) {
    console.warn(
      `noselfgrade: WARNING: builder model "${builder.model}" is not in the family table — ` +
        `only provider-disjointness will be enforced and the certificate will record a degraded guarantee.`,
    );
  }

  // 3. Reviewer bindings from the environment.
  const bindings = buildBindings(env);
  if (bindings.size === 0) {
    throw new CliError(
      `no reviewer API keys found. Set at least one of: ${Object.values(REVIEW_ENV_VARS).join(", ")}`,
      2,
    );
  }

  // 4. Dispatch to disjoint reviewers.
  let result: DispatchResult;
  try {
    result = await deps.dispatchReview({
      builder,
      jury: opts.jury,
      bindings,
      prompt: deps.buildReviewPrompt(diff),
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof DispatchError) throw new CliError(err.message, 2);
    throw err;
  }
  const { reviewers, rawResponses } = result;

  // 5. Parse (+ one repair attempt) → normalize, per reviewer.
  const perReviewer: Finding[][] = [];
  for (const raw of rawResponses) {
    const parsed = await parseOrRepair(deps, bindings, raw.reviewer, raw.text, timeoutMs);
    const model = raw.reviewer.includes(":")
      ? raw.reviewer.slice(raw.reviewer.indexOf(":") + 1)
      : raw.reviewer;
    perReviewer.push(deps.normalizeFindings(parsed, model, diff));
  }

  // 6. Merge jury findings; compute the verdict.
  const findings = deps.mergeJuryFindings(perReviewer);
  const verdict = deps.computeVerdict(findings, opts.failOn);

  // 7. Certify: build the report body, sign (unless --no-sign).
  const report = deps.buildReportBody({
    diff,
    declaredBuilder: builder,
    reviewers,
    findings,
    verdict,
  });
  let cert: Certificate;
  let signed = true;
  if (opts.noSign) {
    cert = { report, signature: "", keyId: "", formatVersion: 1 };
    signed = false;
  } else {
    let keypair: Keypair;
    try {
      keypair = deps.loadKeypair(defaultKeyDir());
    } catch {
      throw new CliError(
        `no signing key found — run "noselfgrade keygen" first (or pass --no-sign to skip signing)`,
        2,
      );
    }
    cert = deps.signReport(report, keypair.privateKey);
  }

  // 8. Render and emit.
  const rendered = deps.render(cert, opts.format);
  const withNewline = rendered.endsWith("\n") ? rendered : rendered + "\n";
  let outputPath: string | undefined;
  if (opts.output) {
    outputPath = resolve(opts.cwd, opts.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, withNewline, "utf8");
  } else {
    process.stdout.write(withNewline);
  }

  // 9. Human summary on stderr.
  const names = reviewers.map((r) => r.model).join(", ");
  console.error(
    `noselfgrade: reviewer(s) [${names}] · ${findings.length} finding(s) · ` +
      `verdict ${verdict} · ${signed ? `signed (key ${cert.keyId})` : "unsigned"}`,
  );

  return {
    exitCode: verdict === "PASS" ? 0 : 1,
    verdict,
    findings,
    reviewers,
    rendered,
    outputPath,
    signed,
  };
}

// ── Section 8: verify / keygen / init / families ───────────────────────────
export interface VerifyOutcome {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function verifyCertificateFile(
  certPath: string,
  publicKeyPath?: string,
): VerifyOutcome {
  const certAbs = resolve(certPath);
  if (!existsSync(certAbs)) {
    throw new CliError(`certificate file not found: ${certPath}`, 2);
  }
  let cert: Certificate;
  try {
    cert = JSON.parse(readFileSync(certAbs, "utf8")) as Certificate;
  } catch (err) {
    throw new CliError(
      `cannot parse certificate JSON: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }
  const pubAbs = publicKeyPath
    ? resolve(publicKeyPath)
    : join(defaultKeyDir(), "id_ed25519.pub");
  if (!existsSync(pubAbs)) {
    throw new CliError(
      `public key not found: ${pubAbs} — pass --public-key or run "noselfgrade keygen"`,
      2,
    );
  }
  const { valid, errors, warnings } = verifyCertificate(cert, readFileSync(pubAbs, "utf8"));
  return { valid, errors, warnings };
}

export interface KeygenResult {
  dir: string;
  privateKeyPath: string;
  publicKeyPath: string;
  keyId: string;
}

export function runKeygen(force: boolean): KeygenResult {
  const dir = defaultKeyDir();
  const privateKeyPath = join(dir, "id_ed25519");
  const publicKeyPath = join(dir, "id_ed25519.pub");
  const exists = existsSync(privateKeyPath) || existsSync(publicKeyPath);
  if (exists && !force) {
    throw new CliError(
      `keypair already exists in ${dir} — pass --force to overwrite`,
      2,
    );
  }
  if (exists && force) {
    if (existsSync(privateKeyPath)) rmSync(privateKeyPath);
    if (existsSync(publicKeyPath)) rmSync(publicKeyPath);
  }
  const keypair = generateKeypair();
  const saved = saveKeypair(dir, keypair);
  return {
    dir,
    privateKeyPath: saved.privateKeyPath,
    publicKeyPath: saved.publicKeyPath,
    keyId: keyIdFor(keypair.publicKey),
  };
}

export function runInit(cwd: string, force: boolean): string {
  const path = join(cwd, CONFIG_FILE);
  if (existsSync(path) && !force) {
    throw new CliError(`${CONFIG_FILE} already exists — pass --force to overwrite`, 2);
  }
  const starter = {
    builderModel: "gpt-5",
    builderProvider: "openai",
    failOn: "high",
    format: "markdown",
    jury: false,
  };
  writeFileSync(path, JSON.stringify(starter, null, 2) + "\n", "utf8");
  return path;
}

export function familiesTable(): string {
  const header = ["MODEL", "FAMILY", "PROVIDER", "NOTES"];
  const rows = listModels().map((e) => [e.model, e.family, e.provider, e.notes ?? ""]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

// ── Section 9: citty commands ──────────────────────────────────────────────
function exitWith(err: unknown): never {
  if (err instanceof CliError) {
    console.error(`noselfgrade: ${err.message}`);
    process.exit(err.exitCode);
  }
  console.error(
    `noselfgrade: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
}

const reviewCmd = defineCommand({
  meta: {
    name: "review",
    description:
      "Review a diff with reviewers disjoint from the declared builder; emit a signed certificate.",
  },
  args: {
    diff: {
      type: "positional",
      description: "Path to a unified diff file (default: git diff)",
      required: false,
    },
    "builder-model": { type: "string", description: "Declared builder model id", alias: "m" },
    "builder-provider": { type: "string", description: "Declared builder provider", alias: "p" },
    "allow-unknown-model": {
      type: "boolean",
      description: "Allow a builder model missing from the family table",
    },
    jury: {
      type: "boolean",
      description: "One reviewer per disjoint provider, up to 3 (default: single reviewer)",
    },
    "fail-on": {
      type: "string",
      description: "Severity threshold for exit 1",
      valueHint: "critical|high|medium|low|info",
    },
    format: {
      type: "string",
      description: "Report format",
      valueHint: "json|markdown|sarif|html",
    },
    output: {
      type: "string",
      description: "Write the report to a file (default: stdout)",
      alias: "o",
    },
    timeout: {
      type: "string",
      description: "Per-reviewer API timeout in seconds (default 120)",
    },
    "no-sign": {
      type: "boolean",
      description: "Skip signing; emit an unsigned certificate",
    },
    staged: {
      type: "boolean",
      description: "Review staged changes (git diff --staged)",
    },
    base: {
      type: "string",
      description: "Review changes since <ref> (git diff <ref>)",
      valueHint: "ref",
    },
  },
  async run({ args }) {
    try {
      const cwd = process.cwd();
      const config = loadConfig(cwd);

      if (args.diff && (args.staged === true || args.base)) {
        console.error(
          "noselfgrade: ignoring --staged/--base: reviewing the diff file instead",
        );
      }
      if (args.staged === true && args.base) {
        throw new CliError("--staged and --base are mutually exclusive", 2);
      }

      const failOnRaw = args["fail-on"] ?? config.failOn ?? "high";
      if (!isSeverity(failOnRaw)) {
        throw new CliError(
          `--fail-on must be one of ${SEVERITIES.join(", ")} (got "${failOnRaw}")`,
          2,
        );
      }
      const formatRaw = args.format ?? config.format ?? "markdown";
      if (!isReportFormat(formatRaw)) {
        throw new CliError(
          `--format must be one of ${REPORT_FORMATS.join(", ")} (got "${formatRaw}")`,
          2,
        );
      }
      const timeoutSec = args.timeout ? Number.parseInt(args.timeout, 10) : 120;
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        throw new CliError(
          `--timeout must be a positive number of seconds (got "${args.timeout}")`,
          2,
        );
      }

      const result = await runReviewPipeline({
        diffFile: args.diff || undefined,
        staged: args.staged === true,
        base: args.base || undefined,
        builderModel:
          args["builder-model"] ??
          process.env.NOSELFGRADE_BUILDER_MODEL ??
          config.builderModel,
        builderProvider:
          args["builder-provider"] ??
          process.env.NOSELFGRADE_BUILDER_PROVIDER ??
          config.builderProvider,
        allowUnknownModel:
          args["allow-unknown-model"] === true || config.allowUnknownModel === true,
        jury: args.jury === true || config.jury === true,
        failOn: failOnRaw,
        format: formatRaw,
        output: args.output || undefined,
        timeoutSec,
        noSign: args["no-sign"] === true,
        cwd,
      });
      process.exit(result.exitCode);
    } catch (err) {
      exitWith(err);
    }
  },
});

const verifyCmd = defineCommand({
  meta: {
    name: "verify",
    description: "Verify a signed NoSelfGrade certificate offline.",
  },
  args: {
    certificate: {
      type: "positional",
      description: "Path to the certificate JSON file",
      required: true,
    },
    "public-key": {
      type: "string",
      description: "Path to the Ed25519 public key (default ~/.noselfgrade/id_ed25519.pub)",
    },
    diff: {
      type: "string",
      description: "Path to the diff file the certificate should cover — its sha256 is compared to report.diffHash (replay protection)",
    },
  },
  async run({ args }) {
    try {
      const { valid, errors, warnings } = verifyCertificateFile(
        args.certificate,
        args["public-key"] || undefined,
      );
      for (const w of warnings) console.warn(`warning: ${w}`);
      if (valid && args.diff) {
        const diffContent = readFileSync(resolve(args.diff as string), "utf8");
        const cert = JSON.parse(readFileSync(resolve(args.certificate as string), "utf8")) as Certificate;
        const actual = hashDiff(diffContent);
        if (actual !== cert.report.diffHash) {
          console.error(
            `invalid certificate: diff hash mismatch — certificate covers ${cert.report.diffHash} ` +
              `but ${args.diff} hashes to ${actual} (possible replay against different code)`,
          );
          process.exit(1);
        }
        console.log(`diff binding: ${args.diff} matches report.diffHash ✓`);
      } else if (valid) {
        console.warn(
          "warning: no --diff provided — replay not checked (this certificate could accompany different code)",
        );
      }
      if (valid) {
        console.log("valid: signature, keyId, and family/provider disjointness check out");
        process.exit(0);
      }
      console.error(`invalid certificate:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
      process.exit(1);
    } catch (err) {
      exitWith(err);
    }
  },
});

const keygenCmd = defineCommand({
  meta: {
    name: "keygen",
    description: "Generate an Ed25519 signing keypair in ~/.noselfgrade.",
  },
  args: {
    force: {
      type: "boolean",
      description: "Overwrite an existing keypair",
    },
  },
  async run({ args }) {
    try {
      const { privateKeyPath, publicKeyPath, keyId } = runKeygen(args.force === true);
      console.log(`private key: ${privateKeyPath} (mode 600)`);
      console.log(`public key:  ${publicKeyPath}`);
      console.log(`key id:      ${keyId}`);
    } catch (err) {
      exitWith(err);
    }
  },
});

const initCmd = defineCommand({
  meta: {
    name: "init",
    description: `Write a starter ${CONFIG_FILE} in the current directory.`,
  },
  args: {
    force: {
      type: "boolean",
      description: "Overwrite an existing config file",
    },
  },
  async run({ args }) {
    try {
      const path = runInit(process.cwd(), args.force === true);
      console.log(`wrote ${path}`);
    } catch (err) {
      exitWith(err);
    }
  },
});

const familiesListCmd = defineCommand({
  meta: { name: "list", description: "Print the model family table." },
  async run() {
    process.stdout.write(familiesTable() + "\n");
  },
});

const familiesCmd = defineCommand({
  meta: { name: "families", description: "Model family table commands." },
  subCommands: { list: familiesListCmd },
});

// ── Section 10: main entry ─────────────────────────────────────────────────
const mainCmd = defineCommand({
  meta: {
    name: "noselfgrade",
    version: VERSION,
    description:
      "Independent code review: reviewers disjoint from the declared builder, with signed certification.",
  },
  subCommands: {
    review: reviewCmd,
    verify: verifyCmd,
    keygen: keygenCmd,
    init: initCmd,
    families: familiesCmd,
  },
});

/** Only invoke the CLI when this module is the node entry point (not under vitest). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runMain(mainCmd);
}
