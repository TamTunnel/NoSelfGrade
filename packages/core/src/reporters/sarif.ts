/**
 * SARIF 2.1.0 reporter. Every finding appears as a result; no invented data.
 * Validated structurally in tests against the official SARIF 2.1.0 schema.
 */

// Minimal typing for createRequire so this package needs no @types/node
// (a type-only shim; the real function is guaranteed by Node >= 20).
declare module "node:module" {
  export function createRequire(filename: string | URL): (id: string) => unknown;
}

import { createRequire } from "node:module";
import type { Certificate, Finding, Severity } from "../types.js";

const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const TOOL_NAME = "noselfgrade";
const TOOL_INFO_URI = "https://github.com/TamTunnel/noselfgrade";

function toolVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function levelFor(severity: Severity): "error" | "warning" | "note" {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
    case "info":
      return "note";
  }
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
}

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
  properties: { severity: Severity; category: string; confidence: number; reviewer: string };
}

function ruleFor(f: Finding): SarifRule {
  return {
    id: `noselfgrade/${f.category}`,
    name: f.category,
    shortDescription: { text: `NoSelfGrade ${f.category} finding (${f.severity})` },
  };
}

function resultFor(f: Finding): SarifResult {
  const physicalLocation: SarifResult["locations"][number]["physicalLocation"] = {
    artifactLocation: { uri: f.file },
  };
  if (f.line !== null) {
    physicalLocation.region = { startLine: f.line };
  }
  return {
    ruleId: `noselfgrade/${f.category}`,
    level: levelFor(f.severity),
    message: { text: f.message },
    locations: [{ physicalLocation }],
    properties: {
      severity: f.severity,
      category: f.category,
      confidence: f.confidence,
      reviewer: f.reviewer,
    },
  };
}

export function renderSarif(cert: Certificate): string {
  const rules: SarifRule[] = [];
  const seen = new Set<string>();
  for (const f of cert.report.findings) {
    if (!seen.has(f.category)) {
      seen.add(f.category);
      rules.push(ruleFor(f));
    }
  }

  const sarif = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: toolVersion(),
            informationUri: TOOL_INFO_URI,
            rules,
          },
        },
        results: cert.report.findings.map(resultFor),
        properties: {
          verdict: cert.report.verdict,
          reviewerModels: cert.report.reviewers.map((r) => r.model),
          diffHash: cert.report.diffHash,
        },
      },
    ],
  };
  return JSON.stringify(sarif, null, 2) + "\n";
}
