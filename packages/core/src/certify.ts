/**
 * Certification / signing for NoSelfGrade.
 *
 * Canonicalizes the report body, hashes the reviewed diff, signs the
 * canonical JSON with Ed25519, and verifies the certificate offline:
 * signature validity, keyId match, format version, timestamp, verdict
 * vocabulary, and family/provider disjointness re-validated from first
 * principles against the curated family table.
 *
 * Key management is user-owned (~/.noselfgrade); no KMS, no hosted PKI.
 * Uses only node built-in `crypto` — zero new dependencies.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BuilderDeclaration,
  Certificate,
  Finding,
  ReportBody,
  ReviewerInfo,
  Severity,
  Verdict,
} from "./types.js";
import { SEVERITY_ORDER } from "./types.js";
import { lookupModel } from "./families.js";

/** Canonical JSON serialization: recursively sort object keys, no whitespace. */
export function canonicalize(report: ReportBody): string {
  return canonicalizeValue(report);
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null"; // only reachable inside arrays
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalize: non-finite numbers cannot be serialized");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeValue).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonicalizeValue(obj[k])).join(",") +
      "}"
    );
  }
  throw new Error(`canonicalize: unsupported value of type ${t}`);
}

/** sha256 hex of the exact diff text. */
export function hashDiff(diff: string): string {
  return createHash("sha256").update(diff, "utf8").digest("hex");
}

export interface Keypair {
  /** SPKI PEM. */
  publicKey: string;
  /** PKCS8 PEM. */
  privateKey: string;
}

/** Generate an Ed25519 keypair via node:crypto. */
export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

/**
 * "keyid:" + first 16 hex chars of sha256(publicKeyDer).
 * Throws on malformed PEM (programmer error).
 */
export function keyIdFor(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const hex = createHash("sha256").update(der).digest("hex");
  return "keyid:" + hex.slice(0, 16);
}

/**
 * Sign canonicalize(report) with Ed25519; keyId is derived from the
 * private key's public half. The report object is stored as-is.
 */
export function signReport(report: ReportBody, privateKeyPem: string): Certificate {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
  const publicPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const canonical = canonicalize(report);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  return {
    report,
    signature,
    keyId: keyIdFor(publicPem),
    formatVersion: 1,
  };
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
  /**
   * Non-fatal notes: the certificate is valid but the guarantee is degraded
   * (e.g. builder family unknown, so only provider-disjointness was
   * re-validated). Callers should surface these alongside the verdict.
   */
  warnings: string[];
}

/**
 * Verify a certificate offline. Checks the Ed25519 signature over
 * canonicalize(cert.report), that cert.keyId matches the given public key,
 * formatVersion === 1, that report.timestamp parses as a date, that the
 * verdict is PASS|FAIL, and re-validates family/provider disjointness from
 * first principles: each reviewer's model is looked up in the family table
 * and must match neither the builder's family nor the builder's provider.
 *
 * Never throws on bad input — returns { valid: false, errors: [...] }.
 * Throws only on programmer errors (e.g. lookupModel itself throwing).
 */
export function verifyCertificate(cert: Certificate, publicKeyPem: string): VerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    if (cert === null || cert === undefined || typeof cert !== "object") {
      return { valid: false, errors: ["certificate must be an object"], warnings };
    }

    if ((cert as { formatVersion?: unknown }).formatVersion !== 1) {
      errors.push(
        `unsupported formatVersion ${JSON.stringify(
          (cert as { formatVersion?: unknown }).formatVersion,
        )}: expected 1`,
      );
    }

    const report = (cert as { report?: unknown }).report;
    if (report === null || report === undefined || typeof report !== "object") {
      errors.push("certificate is missing its report body");
      return { valid: false, errors, warnings };
    }
    const r = report as ReportBody;

    // Timestamp must parse as a date.
    if (typeof r.timestamp !== "string" || Number.isNaN(Date.parse(r.timestamp))) {
      errors.push(`report.timestamp is not a parseable date: ${JSON.stringify(r.timestamp)}`);
    }

    // Verdict vocabulary.
    if (r.verdict !== "PASS" && r.verdict !== "FAIL") {
      errors.push(`report.verdict must be "PASS" or "FAIL", got ${JSON.stringify(r.verdict)}`);
    }

    // keyId must match the provided public key.
    let expectedKeyId: string | undefined;
    try {
      expectedKeyId = keyIdFor(publicKeyPem);
    } catch {
      errors.push("public key is not a valid Ed25519 SPKI PEM");
    }
    if (expectedKeyId !== undefined && cert.keyId !== expectedKeyId) {
      errors.push(
        `keyId mismatch: certificate claims ${JSON.stringify(cert.keyId)} ` +
          `but the public key is ${expectedKeyId}`,
      );
    }

    // Signature over the canonical report.
    try {
      const signatureBytes = Buffer.from(cert.signature ?? "", "base64");
      if (signatureBytes.length === 0 && !cert.signature) {
        errors.push("certificate is missing its signature");
      } else {
        const canonical = Buffer.from(canonicalize(r), "utf8");
        const ok = verify(null, canonical, createPublicKey(publicKeyPem), signatureBytes);
        if (!ok) {
          errors.push("Ed25519 signature is invalid for this report");
        }
      }
    } catch {
      errors.push("signature verification failed (malformed signature or key)");
    }

    // Re-validate family/provider disjointness from first principles.
    validateDisjointness(r, errors, warnings);
  } catch (e) {
    errors.push(
      `verification aborted: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Re-validate that every reviewer is disjoint from the declared builder. */
function validateDisjointness(
  report: ReportBody,
  errors: string[],
  warnings: string[],
): void {
  const declared = report.declaredBuilder;
  const builderModel =
    declared !== null && typeof declared === "object" ? declared.model : undefined;
  if (typeof builderModel !== "string" || builderModel.length === 0) {
    errors.push("report.declaredBuilder.model is missing");
    return;
  }
  const builderEntry = lookupModel(builderModel);
  const declaredFamily =
    declared !== null && typeof declared === "object"
      ? (declared as { family?: unknown }).family
      : undefined;
  // Unknown builder model (family: null): only provider-disjointness can be
  // re-validated. This is a degraded guarantee, not an invalid cert.
  if (!builderEntry) {
    if (declaredFamily !== null) {
      errors.push(
        `cannot re-validate disjointness: builder model ${JSON.stringify(
          builderModel,
        )} is not in the family table`,
      );
      return;
    }
    warnings.push(
      `builder model ${JSON.stringify(builderModel)} is not in the family table: ` +
        `family-disjointness could not be re-validated; only provider-disjointness was checked`,
    );
    checkProviderOnly(report, builderModel, String((declared as { provider?: unknown }).provider ?? ""), errors);
    return;
  }

  const reviewers = Array.isArray(report.reviewers) ? report.reviewers : [];
  for (const reviewer of reviewers) {
    const model =
      reviewer !== null && typeof reviewer === "object"
        ? (reviewer as ReviewerInfo).model
        : undefined;
    if (typeof model !== "string" || model.length === 0) {
      errors.push("a reviewer entry is missing its model id");
      continue;
    }
    const entry = lookupModel(model);
    if (!entry) {
      errors.push(
        `cannot re-validate disjointness: reviewer model ${JSON.stringify(
          model,
        )} is not in the family table`,
      );
      continue;
    }
    if (entry.family === builderEntry.family) {
      errors.push(
        `disjointness violation: reviewer ${JSON.stringify(model)} is in family ` +
          `"${entry.family}", the same family as declared builder ${JSON.stringify(builderModel)}`,
      );
    }
    if (entry.provider === builderEntry.provider) {
      errors.push(
        `disjointness violation: reviewer ${JSON.stringify(model)} is served by provider ` +
          `"${entry.provider}", the same provider as declared builder ${JSON.stringify(builderModel)}`,
      );
    }
  }
}

/** Provider-only disjointness check for unknown-builder certs. */
function checkProviderOnly(
  report: ReportBody,
  builderModel: string,
  builderProvider: string,
  errors: string[],
): void {
  const reviewers = Array.isArray(report.reviewers) ? report.reviewers : [];
  for (const reviewer of reviewers) {
    const info = reviewer as { model?: unknown; provider?: unknown };
    const provider =
      reviewer !== null && typeof reviewer === "object" && typeof info.provider === "string"
        ? info.provider
        : undefined;
    if (!provider) continue;
    if (provider === builderProvider) {
      errors.push(
        `disjointness violation: reviewer ${JSON.stringify(info.model)} is served by provider ` +
          `"${provider}", the same provider as declared builder ${JSON.stringify(builderModel)}`,
      );
    }
  }
}

/** Build a ReportBody: diffHash = hashDiff(diff), timestamp = now (ISO-8601 UTC). */
export function buildReportBody(opts: {
  diff: string;
  declaredBuilder: BuilderDeclaration;
  reviewers: ReviewerInfo[];
  findings: Finding[];
  verdict: Verdict;
}): ReportBody {
  return {
    diffHash: hashDiff(opts.diff),
    declaredBuilder: opts.declaredBuilder,
    reviewers: opts.reviewers,
    findings: opts.findings,
    verdict: opts.verdict,
    timestamp: new Date().toISOString(),
  };
}

/**
 * FAIL if any finding has severity >= failOn in SEVERITY_ORDER; else PASS.
 * The runner decides the verdict; this is the shared threshold rule.
 */
export function computeVerdict(findings: Finding[], failOn: Severity): Verdict {
  const threshold = SEVERITY_ORDER[failOn];
  for (const f of findings) {
    if (SEVERITY_ORDER[f.severity] >= threshold) return "FAIL";
  }
  return "PASS";
}

// --- Key management (user-owned keys, ~/.noselfgrade) ---

/** join(homedir(), ".noselfgrade") */
export function defaultKeyDir(): string {
  return join(homedir(), ".noselfgrade");
}

export interface SavedKeypair {
  publicKeyPath: string;
  privateKeyPath: string;
}

/**
 * Write id_ed25519 (mode 0o600) and id_ed25519.pub into dir (created mode
 * 0o700). Throws without writing anything if either file already exists
 * (no clobber).
 */
export function saveKeypair(dir: string, kp: Keypair): SavedKeypair {
  const privateKeyPath = join(dir, "id_ed25519");
  const publicKeyPath = join(dir, "id_ed25519.pub");
  if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
    throw new Error(
      `refusing to overwrite existing key in ${dir} ` +
        `(id_ed25519${existsSync(privateKeyPath) ? " exists" : ""}` +
        `${existsSync(publicKeyPath) ? ", id_ed25519.pub exists" : ""}). ` +
        `Delete it yourself or use a different directory.`,
    );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, kp.privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath, kp.publicKey, { mode: 0o644 });
  return { publicKeyPath, privateKeyPath };
}

/** Load the keypair from dir (default: ~/.noselfgrade). Throws if missing. */
export function loadKeypair(dir: string = defaultKeyDir()): Keypair {
  const privateKeyPath = join(dir, "id_ed25519");
  const publicKeyPath = join(dir, "id_ed25519.pub");
  const missing: string[] = [];
  if (!existsSync(privateKeyPath)) missing.push("id_ed25519");
  if (!existsSync(publicKeyPath)) missing.push("id_ed25519.pub");
  if (missing.length > 0) {
    throw new Error(
      `No keypair found in ${dir} (missing: ${missing.join(", ")}). ` +
        `Generate one with: noselfgrade keygen`,
    );
  }
  // Warn (SSH-style) if the private key is readable by group/other — it was
  // written mode 600, so loose permissions mean something changed it.
  try {
    const mode = statSync(privateKeyPath).mode & 0o777;
    if (mode & 0o077) {
      console.warn(
        `noselfgrade: WARNING: private key ${privateKeyPath} has permissions ` +
          `0${mode.toString(8)} (expected 600) — tighten with chmod 600`,
      );
    }
  } catch {
    // stat failure is non-fatal; the read below will surface real problems.
  }
  return {
    publicKey: readFileSync(publicKeyPath, "utf8"),
    privateKey: readFileSync(privateKeyPath, "utf8"),
  };
}
