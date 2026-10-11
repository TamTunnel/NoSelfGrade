/**
 * Unified diff parsing. Lenient by design: never throws on weird input,
 * returns whatever parses cleanly.
 */

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  /** Hunk body lines, each retaining its leading '+', '-', or ' ' prefix. */
  lines: string[];
}

export interface DiffFile {
  /** File path from the b/ side (a/ side for deleted files). */
  path: string;
  hunks: DiffHunk[];
}

const DEV_NULL = "/dev/null";

/** Strip the leading `a/` or `b/` prefix from a diff path. */
function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Parse a hunk header like `@@ -1,3 +4,5 @@ context` → { oldStart, newStart }. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  const oldStart = Number.parseInt(m[1], 10);
  const newStart = Number.parseInt(m[2], 10);
  if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)) return null;
  return { oldStart, newStart };
}

interface ParsedFileState {
  file: DiffFile;
  minusPath: string | null;
  plusPath: string | null;
}

/**
 * Parse a unified diff into per-file hunks.
 *
 * Handles `diff --git` headers, `---`/`+++` path lines, `/dev/null` for
 * new/deleted files, `\ No newline at end of file` markers, and plain
 * unified diffs without a `diff --git` header. Anything unrecognized is
 * skipped; the function never throws.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: ParsedFileState | null = null;
  let currentHunk: DiffHunk | null = null;

  const finishHunk = (): void => {
    if (current && currentHunk) current.file.hunks.push(currentHunk);
    currentHunk = null;
  };
  const finishFile = (): void => {
    finishHunk();
    if (current) {
      const { minusPath, plusPath, file } = current;
      // Resolve the path: prefer the b/ side; fall back to a/ for deletions.
      if (plusPath && plusPath !== DEV_NULL) {
        file.path = stripPrefix(plusPath);
      } else if (minusPath && minusPath !== DEV_NULL) {
        file.path = stripPrefix(minusPath);
      } else if (plusPath) {
        file.path = stripPrefix(plusPath);
      }
      files.push(file);
    }
    current = null;
  };

  for (const rawLine of diff.split("\n")) {
    // Strip a trailing \r so CRLF diffs parse cleanly.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      finishFile();
      current = { file: { path: "", hunks: [] }, minusPath: null, plusPath: null };
      currentHunk = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      // A --- line without a preceding diff --git starts a plain unified diff.
      if (!current) {
        current = { file: { path: "", hunks: [] }, minusPath: null, plusPath: null };
      } else {
        finishHunk();
      }
      current.minusPath = line.slice(4).split("\t")[0].trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!current) {
        current = { file: { path: "", hunks: [] }, minusPath: null, plusPath: null };
      }
      current.plusPath = line.slice(4).split("\t")[0].trim();
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) {
        // Hunk header with no file context — start an anonymous file entry.
        current = { file: { path: "", hunks: [] }, minusPath: null, plusPath: null };
      }
      const header = parseHunkHeader(line);
      if (!header) {
        currentHunk = null;
        continue;
      }
      finishHunk();
      currentHunk = { oldStart: header.oldStart, newStart: header.newStart, lines: [] };
      continue;
    }
    if (line.startsWith("\\ ")) {
      // "\ No newline at end of file" — not a content line.
      continue;
    }
    if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      currentHunk.lines.push(line);
      continue;
    }
    // Anything else (index lines, mode lines, stray text) is ignored.
  }
  finishFile();

  // Drop files that never got a path (e.g. stray hunks without headers).
  return files.filter((f) => f.path !== "");
}

/**
 * Map of file path → set of new-file line numbers for added ('+') lines.
 *
 * Used by finding normalization to validate reviewer-cited line numbers
 * against the actual diff, with ±3-line drift tolerance.
 */
export function addedLineNumbers(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const file of parseDiff(diff)) {
    const added = new Set<number>();
    for (const hunk of file.hunks) {
      let newLine = hunk.newStart;
      for (const line of hunk.lines) {
        const prefix = line[0];
        if (prefix === "+") {
          added.add(newLine);
          newLine += 1;
        } else if (prefix === " ") {
          newLine += 1;
        }
        // '-' lines do not advance the new-file line counter.
      }
    }
    const existing = result.get(file.path);
    if (existing) {
      for (const n of added) existing.add(n);
    } else {
      result.set(file.path, added);
    }
  }
  return result;
}
