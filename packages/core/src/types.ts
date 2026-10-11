/**
 * Shared types for NoSelfGrade. This file is the integration contract —
 * every component imports these rather than redefining them.
 */

/** Builder identity as DECLARED by the user (untrusted, recorded verbatim). */
export interface BuilderDeclaration {
  model: string;
  provider: string;
  /**
   * Resolved family from the table, or null when the model is unknown
   * (--allow-unknown-model). Null means only provider-disjointness was
   * enforced — the certificate records this so readers can tell a
   * degraded guarantee from a full one.
   */
  family: string | null;
}

/** One row of the curated model-family table. */
export interface FamilyEntry {
  /** Model id as used in provider APIs, e.g. "claude-opus-4-6". */
  model: string;
  /** Semantic family, e.g. "claude", "gpt", "llama". */
  family: string;
  /** Provider that serves it, e.g. "anthropic", "openai". */
  provider: string;
  notes?: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "correctness" | "security" | "style" | "perf";

/** One normalized review finding. */
export interface Finding {
  severity: Severity;
  file: string;
  /** Null when the cited location could not be resolved in the diff. */
  line: number | null;
  category: Category;
  /** 0..1 */
  confidence: number;
  message: string;
  remediation?: string;
  /** Reviewer model id that produced this finding. */
  reviewer: string;
}

/** Which reviewer endpoint ran, with proof of invocation. */
export interface ReviewerInfo {
  provider: string;
  model: string;
  /** sha256(apiKey) truncated to 16 hex chars — proves which key/endpoint ran. */
  apiKeyFingerprint: string;
}

export type Verdict = "PASS" | "FAIL";

/** The canonical report body that gets signed. */
export interface ReportBody {
  /** sha256 hex of the exact reviewed diff text. */
  diffHash: string;
  declaredBuilder: BuilderDeclaration;
  reviewers: ReviewerInfo[];
  findings: Finding[];
  verdict: Verdict;
  /** ISO-8601 UTC. */
  timestamp: string;
}

/** The signed certification envelope. */
export interface Certificate {
  report: ReportBody;
  /** Ed25519 signature over canonical JSON of report, base64. */
  signature: string;
  /** Public key id (sha256 of public key, truncated). */
  keyId: string;
  /** Canonicalization version, for forward compatibility. */
  formatVersion: 1;
}

/** Severity ordering for threshold comparisons. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
