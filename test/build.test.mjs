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
// Content lives under public/ — the only directory Cloudflare ever uploads.
const write = (repo, rel, text) => {
  mkdirSync(join(repo, "public", rel, ".."), { recursive: true });
  writeFileSync(join(repo, "public", rel), text);
};
const read = (repo, rel) => readFileSync(join(repo, "public", rel), "utf8");

test("markdown renders, wikilinks resolve, code fences stay literal", async () => {
  const repo = scaffold();
  write(repo, "notes/one.md", "# One\n\nSee [[two]] and [[two|other]].\n\n```js\n[[literal]]\n```\n");
  write(repo, "notes/two.md", "# Two\n");
  await build(repo, { quiet: true });

  const html = read(repo, "notes/one.html");
  // Pages serves two.html at /notes/two and 308s the .html form, so links
  // must already be in the canonical extensionless shape.
  assert.match(html, /<a href="\/notes\/two">Two<\/a>/);
  assert.match(html, /<a href="\/notes\/two">other<\/a>/);
  assert.doesNotMatch(html, /href="[^"]*\.html"/, "links must not carry .html");
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

  const worker = (
    await import(`${pathToFileURL(join(repo, "worker", "index.js")).href}?v=${Date.now()}`)
  ).default;
  const env = { ASSETS: { fetch: async () => new Response("CONTENT", { headers: { "Cache-Control": "public" } }) } };
  const hit = (path, pw) =>
    worker.fetch(
      new Request("https://x.dev" + path, pw
        ? { headers: { Authorization: "Basic " + Buffer.from("u:" + pw).toString("base64") } }
        : {}),
      env,
    );

  for (const path of ["/private-xyz/", "/private-xyz/brief", "/private-xyz/spec.pdf"]) {
    assert.equal((await hit(path)).status, 401, `${path} must be gated`);
    assert.equal((await hit(path, "wrong")).status, 401, `${path} must reject a wrong password`);
    const ok = await hit(path, password);
    assert.equal(ok.status, 200, `${path} must open with the generated password`);
    assert.equal(ok.headers.get("Cache-Control"), "private, no-store");
  }
});
