// node --test test/*.test.mjs  (npm test points DUMPYARD_HOME at a temp dir)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as locks from "../src/locks.mjs";
import * as store from "../src/store.mjs";

const TEMPLATES = fileURLToPath(new URL("../templates", import.meta.url));
const scaffold = () => {
  const repo = mkdtempSync(join(tmpdir(), "dumpyard-exp-"));
  cpSync(TEMPLATES, repo, { recursive: true });
  return repo;
};
const gate = async (repo) => {
  pepper = store.pepper(repo).value;
  return (await import(`${pathToFileURL(join(repo, "worker", "index.js")).href}?v=${Math.random()}`)).default;
};
let pepper; // the repo under test's, set by gate()
const hit = (worker, path, pw) =>
  worker.fetch(
    new Request("https://x.dev" + path, pw
      ? { headers: { Authorization: "Basic " + Buffer.from("u:" + pw).toString("base64") } }
      : {}),
    { ASSETS: { fetch: async () => new Response("CONTENT") }, DUMPYARD_PEPPER: pepper },
  );
// Force an expiry into the past without waiting, by editing the lock table.
const backdate = async (repo, path) => {
  const table = await locks.load(repo);
  table[path].expires = Date.now() - 1000;
  locks.save(repo, table);
};

test("parseWhen reads durations, dates and never; rejects junk and the past", () => {
  const now = Date.UTC(2026, 8, 26, 12);
  assert.equal(locks.parseWhen("30m", now), now + 30 * 60e3);
  assert.equal(locks.parseWhen("7d", now), now + 7 * 86400e3);
  assert.equal(locks.parseWhen("2026-10-01", now), Date.UTC(2026, 9, 1));
  assert.equal(locks.parseWhen("never", now), null);
  assert.throws(() => locks.parseWhen("soon", now), /can't read/);
  assert.throws(() => locks.parseWhen("2020-01-01", now), /in the past/);
});

test("a live link still needs the password", async () => {
  const repo = scaffold();
  const { password: pw } = await locks.lock(repo, "/share/", undefined, "https://x.dev");
  await locks.setExpiry(repo, "/share/", "7d");
  const worker = await gate(repo);
  assert.equal((await hit(worker, "/share/")).status, 401);
  assert.equal((await hit(worker, "/share/", pw)).status, 200);
});

test("an expired link is dead even with the right password", async () => {
  const repo = scaffold();
  const { password: pw } = await locks.lock(repo, "/share/", undefined, "https://x.dev");
  await locks.setExpiry(repo, "/share/", "7d");
  await backdate(repo, "/share/");
  const worker = await gate(repo);
  for (const path of ["/share/", "/share/page", "/share/file.pdf"]) {
    const res = await hit(worker, path, pw);
    assert.equal(res.status, 410, `${path} must be gone`);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }
  assert.equal((await hit(worker, "/share/")).status, 410, "and without it");
});

test("rotating a password does not extend the link's life", async () => {
  const repo = scaffold();
  await locks.lock(repo, "/share/", undefined, "https://x.dev");
  const at = await locks.setExpiry(repo, "/share/", "3d");
  await locks.lock(repo, "/share/", undefined, "https://x.dev"); // new password
  assert.equal((await locks.load(repo))["/share/"].expires, at);
});

test("expiry can be cleared, and only applies to locked paths", async () => {
  const repo = scaffold();
  await locks.lock(repo, "/share/", undefined, "https://x.dev");
  await locks.setExpiry(repo, "/share/", "3d");
  assert.equal(await locks.setExpiry(repo, "/share/", "never"), null);
  assert.equal((await locks.load(repo))["/share/"].expires, undefined);
  await assert.rejects(locks.setExpiry(repo, "/public/", "3d"), /not locked/);
});
