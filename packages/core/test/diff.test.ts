import { describe, expect, it } from "vitest";
import { addedLineNumbers, parseDiff } from "../src/diff.js";

const MULTI_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-old line
+new line
+another added
 line3
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +10,3 @@
 context
-removed
+added one
+added two
`;

const NEW_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
+export const z = 3;
\\ No newline at end of file
`;

const DELETED_FILE_DIFF = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const old = true;
-const more = 1;
-const last = 2;
`;

describe("parseDiff", () => {
  it("parses a multi-file diff with paths from the b/ side", () => {
    const files = parseDiff(MULTI_FILE_DIFF);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[1].hunks).toHaveLength(1);
  });

  it("parses hunk headers into old/new start line numbers", () => {
    const files = parseDiff(MULTI_FILE_DIFF);
    expect(files[0].hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(files[1].hunks[0]).toMatchObject({ oldStart: 10, newStart: 10 });
  });

  it("keeps hunk body lines with their +/-/space prefixes", () => {
    const files = parseDiff(MULTI_FILE_DIFF);
    expect(files[0].hunks[0].lines).toEqual([
      " line1",
      "-old line",
      "+new line",
      "+another added",
      " line3",
    ]);
  });

  it("handles new files (/dev/null on the minus side)", () => {
    const files = parseDiff(NEW_FILE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/new.ts");
    expect(files[0].hunks[0].lines).toEqual([
      "+export const x = 1;",
      "+export const y = 2;",
      "+export const z = 3;",
    ]);
  });

  it("handles deleted files (/dev/null on the plus side, falls back to a/ path)", () => {
    const files = parseDiff(DELETED_FILE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/gone.ts");
    expect(files[0].hunks[0].lines).toEqual([
      "-export const old = true;",
      "-const more = 1;",
      "-const last = 2;",
    ]);
  });

  it("skips '\\ No newline at end of file' markers", () => {
    const files = parseDiff(NEW_FILE_DIFF);
    expect(files[0].hunks[0].lines.every((l) => !l.startsWith("\\"))).toBe(true);
  });

  it("parses multiple hunks per file", () => {
    const diff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,3 @@
 a
+b
 c
@@ -20,2 +21,2 @@
-d
+e
 f
`;
    const files = parseDiff(diff);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[1]).toMatchObject({ oldStart: 20, newStart: 21 });
  });

  it("never throws on garbage input", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("not a diff at all\n@@@ broken\n")).toEqual([]);
    expect(parseDiff("diff --git a/x b/x\n")).toEqual([]);
    expect(parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ bogus @@\n+ok\n")).toEqual([
      { path: "x", hunks: [] },
    ]);
  });

  it("parses plain unified diffs without a diff --git header", () => {
    const diff = `--- a/plain.ts
+++ b/plain.ts
@@ -1,1 +1,2 @@
 old
+new
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("plain.ts");
    expect(files[0].hunks[0].lines).toEqual([" old", "+new"]);
  });
});

describe("addedLineNumbers", () => {
  it("returns new-file line numbers for added lines", () => {
    const map = addedLineNumbers(MULTI_FILE_DIFF);
    // src/a.ts hunk starts at new line 1: " line1"(1), "-old line", "+new line"(2), "+another added"(3), " line3"(4)
    expect(map.get("src/a.ts")).toEqual(new Set([2, 3]));
    // src/b.ts hunk starts at new line 10: " context"(10), "-removed", "+added one"(11), "+added two"(12)
    expect(map.get("src/b.ts")).toEqual(new Set([11, 12]));
  });

  it("counts added lines in new files starting from line 1", () => {
    const map = addedLineNumbers(NEW_FILE_DIFF);
    expect(map.get("src/new.ts")).toEqual(new Set([1, 2, 3]));
  });

  it("returns an empty set for deleted files", () => {
    const map = addedLineNumbers(DELETED_FILE_DIFF);
    expect(map.get("src/gone.ts")).toEqual(new Set());
  });

  it("tracks line numbers across multiple hunks", () => {
    const diff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
+top
 a
@@ -50,1 +50,2 @@
 ctx
+bottom
`;
    const map = addedLineNumbers(diff);
    expect(map.get("f.ts")).toEqual(new Set([1, 51]));
  });

  it("handles CRLF line endings", () => {
    const map = addedLineNumbers(MULTI_FILE_DIFF.replaceAll("\n", "\r\n"));
    expect(map.get("src/a.ts")).toEqual(new Set([2, 3]));
  });
});
