// The README's command table is a copy of `dumpyard --help`. It drifted once
// already; this keeps it honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("README command table matches --help", () => {
  const bin = fileURLToPath(new URL("../bin/dumpyard.mjs", import.meta.url));
  const lines = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("dumpyard publish"));
  const end = lines.findIndex((l) => l.trim().startsWith("Every command that changes"));
  const table = lines.slice(start, end).map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n").trimEnd();
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(table), "README ## Commands is out of date — regenerate it from --help");
});
