// node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { build } from "../src/build.mjs";
import * as locks from "../src/locks.mjs";

const TEMPLATES = fileURLToPath(new URL("../templates", import.meta.url));

function scaffold() {
  const repo = mkdtempSync(join(tmpdir(), "dumpyard-test-"));
  cpSync(TEMPLATES, repo, { recursive: true });
  return repo;
}
const write = (repo, rel, text) => {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const read = (repo, rel) => readFileSync(join(repo, rel), "utf8");

test("markdown renders, wikilinks resolve, code fences stay literal", async () => {
  const repo = scaffold();
  write(repo, "notes/one.md", "# One\n\nSee [[two]] and [[two|other]].\n\n```js\n[[literal]]\n```\n");
  write(repo, "notes/two.md", "# Two\n");
  await build(repo, { quiet: true });

  const html = read(repo, "notes/one.html");
  assert.match(html, /<a href="\/notes\/two\.html">Two<\/a>/);
  assert.match(html, /<a href="\/notes\/two\.html">other<\/a>/);
  assert.match(html, /\[\[literal\]\]/, "code fence contents must not be linkified");
});

test("a locked folder is absent from the public root index", async () => {
  const repo = scaffold();
  write(repo, "open/a.md", "# Open A\n");
  write(repo, "private-xyz/b.md", "# Secret B\n");
  await locks.lock(repo, "/private-xyz/");
  await build(repo, { quiet: true });

  const root = read(repo, "index.html");
  assert.match(root, /\/open\//);
  assert.doesNotMatch(root, /private-xyz/);
  // but the locked folder's own index does list its contents
  assert.match(read(repo, "private-xyz/index.html"), /Secret B/);
});

test("a public page cannot link into a locked folder", async () => {
  const repo = scaffold();
  write(repo, "open/note.md", "# Open\n\nLinks to [[brief]].\n");
  write(repo, "private-xyz/brief.md", "# The Confidential Brief\n");
  await locks.lock(repo, "/private-xyz/");
  const { broken } = await build(repo, { quiet: true });

  const html = read(repo, "open/note.html");
  assert.doesNotMatch(html, /private-xyz/, "locked URL leaked onto a public page");
  assert.doesNotMatch(html, /Confidential/, "locked title leaked onto a public page");
  assert.ok(broken.some((b) => b.target === "brief" && b.hidden), "should report it as hidden");
});

test("inside the same lock, links resolve normally", async () => {
  const repo = scaffold();
  write(repo, "private-xyz/note.md", "# Note\n\nSee [[brief]].\n");
  write(repo, "private-xyz/brief.md", "# The Confidential Brief\n");
  await locks.lock(repo, "/private-xyz/");
  await build(repo, { quiet: true });
  assert.match(read(repo, "private-xyz/note.html"), /The Confidential Brief/);
});

test("end to end: the generated password opens the gate, and nothing is cached", async () => {
  const repo = scaffold();
  write(repo, "private-xyz/brief.md", "# Brief\n");
  write(repo, "private-xyz/spec.pdf", "%PDF-1.4");
  const password = await locks.lock(repo, "/private-xyz/");
  await build(repo, { quiet: true });

  const { onRequest } = await import(
    `${pathToFileURL(join(repo, "functions", "_middleware.js")).href}?v=${Date.now()}`
  );
  const next = async () => new Response("CONTENT", { headers: { "Cache-Control": "public" } });
  const hit = (path, pw) =>
    onRequest({
      request: new Request("https://x.dev" + path, pw
        ? { headers: { Authorization: "Basic " + Buffer.from("u:" + pw).toString("base64") } }
        : {}),
      next,
    });

  for (const path of ["/private-xyz/", "/private-xyz/brief.html", "/private-xyz/spec.pdf"]) {
    assert.equal((await hit(path)).status, 401, `${path} must be gated`);
    assert.equal((await hit(path, "wrong")).status, 401, `${path} must reject a wrong password`);
    const ok = await hit(path, password);
    assert.equal(ok.status, 200, `${path} must open with the generated password`);
    assert.equal(ok.headers.get("Cache-Control"), "private, no-store");
  }
});
