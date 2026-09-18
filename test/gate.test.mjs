// node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { authorized } from "../templates/worker/index.js";
import { digest, sameDigest, lockFor } from "../templates/worker/hash.js";

const assets = (body = "secret") => ({
  fetch: async () => new Response(body, { headers: { "Cache-Control": "public, max-age=3600" } }),
});
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
const req = (path, auth) =>
  new Request("https://x.dev" + path, auth ? { headers: { Authorization: auth } } : {});
const fixture = async (password) => {
  const salt = "00112233445566778899aabbccddeeff";
  return { prefix: "/p/", salt, hash: await digest(salt, password) };
};

test("wrangler config runs the Worker BEFORE static assets", () => {
  // Load-bearing. Cloudflare serves matching assets before the Worker by
  // default, which would bypass the gate completely and publish every locked
  // page. If this assertion ever fails, the site is wide open.
  const raw = readFileSync(new URL("../templates/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.assets.run_worker_first, true, "run_worker_first must stay true");
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.assets.directory, "./public", "only ./public may be uploaded");
  assert.equal(config.main, "worker/index.js");
});

test("prefix matching: longest wins, slashes bound it", () => {
  const locks = { "/plans/": {}, "/research/secret/": {}, "/plans/q3/": {} };
  assert.equal(lockFor(locks, "/research/"), null);
  assert.equal(lockFor(locks, "/research/secretly/"), null);
  assert.equal(lockFor(locks, "/research/secret/").prefix, "/research/secret/");
  assert.equal(lockFor(locks, "/research/secret").prefix, "/research/secret/");
  assert.equal(lockFor(locks, "/plans/q3/a.png").prefix, "/plans/q3/");
});

test("one lock covers every file type beneath it", () => {
  const locks = { "/project-xyz/": {} };
  for (const f of ["brief", "brief.md", "spec.pdf", "diagram.png", "", "sub/deep"]) {
    assert.equal(lockFor(locks, `/project-xyz/${f}`)?.prefix, "/project-xyz/", f);
  }
});

test("sameDigest rejects length and single-bit changes", async () => {
  const a = await digest("s", "pw");
  assert.ok(sameDigest(a, await digest("s", "pw")));
  assert.ok(!sameDigest(a, await digest("s", "pX")));
  assert.ok(!sameDigest(a, a.slice(0, -1)));
});

test("authorized: only the right password passes", async () => {
  const lock = await fixture("correct horse");
  assert.ok(await authorized(req("/", basic("anyone", "correct horse")), lock));
  assert.ok(!(await authorized(req("/", basic("anyone", "wrong")), lock)));
  assert.ok(!(await authorized(req("/"), lock)));
  assert.ok(!(await authorized(req("/", "Basic !!!not-base64"), lock)));
  assert.ok(!(await authorized(req("/", "Bearer tok"), lock)));
});

test("an unlocked path is served straight from assets", async () => {
  const res = await worker.fetch(req("/open/"), { ASSETS: assets("public page") });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "public page");
});
