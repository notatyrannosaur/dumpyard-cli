// node --test test/*.test.mjs
// Redirected before importing anything that reads it, so the real
// ~/.config/dumpyard is never touched by the suite.
import { mkdtempSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
process.env.DUMPYARD_HOME = mkdtempSync(join(tmpdir(), "dumpyard-home-"));

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const store = await import("../src/store.mjs");
const locks = await import("../src/locks.mjs");
const { build } = await import("../src/build.mjs");
const { fileURLToPath } = await import("node:url");
const { cpSync } = await import("node:fs");

const TEMPLATES = fileURLToPath(new URL("../templates", import.meta.url));
const scaffold = () => {
  const repo = mkdtempSync(join(tmpdir(), "dumpyard-repo-"));
  cpSync(TEMPLATES, repo, { recursive: true });
  return repo;
};

test("the store never lives inside a content repo", () => {
  // init must refuse any repo that would swallow the store, or the passwords
  // get committed, pushed and deployed.
  assert.equal(store.wouldContainStore(store.home()), true);
  assert.equal(store.wouldContainStore(join(store.home(), "..")), true, "an ancestor too");
  assert.equal(store.wouldContainStore(mkdtempSync(join(tmpdir(), "elsewhere-"))), false);
});

test("passwords are readable back, and the file is owner-only", async () => {
  const repo = scaffold();
  const password = await locks.lock(repo, "/project-xyz/", undefined, "https://x.dev");
  assert.equal(store.recall(repo, "/project-xyz/"), password, "must be retrievable");
  // Retrievable a second and third time — agents re-share links.
  assert.equal(store.recall(repo, "/project-xyz/"), password);
  assert.equal((statSync(store.storePath()).mode & 0o777), 0o600, "must be mode 0600");
});

test("a hand-picked password is stored too", async () => {
  const repo = scaffold();
  await locks.lock(repo, "/manual/", "a-properly-long-one", "https://x.dev");
  assert.equal(store.recall(repo, "/manual/"), "a-properly-long-one");
});

test("unlocking forgets the password", async () => {
  const repo = scaffold();
  await locks.lock(repo, "/gone/", undefined, "https://x.dev");
  await locks.unlock(repo, "/gone/");
  assert.equal(store.recall(repo, "/gone/"), null);
  assert.deepEqual(Object.keys(await locks.load(repo)), []);
});

test("two repos keep separate passwords for the same path", async () => {
  const [a, b] = [scaffold(), scaffold()];
  const pa = await locks.lock(a, "/shared/", undefined, "https://a.dev");
  const pb = await locks.lock(b, "/shared/", undefined, "https://b.dev");
  assert.notEqual(pa, pb);
  assert.equal(store.recall(a, "/shared/"), pa);
  assert.equal(store.recall(b, "/shared/"), pb);
});

test("unlockUnder drops nested locks and their passwords", async () => {
  const repo = scaffold();
  await locks.lock(repo, "/proj/", undefined, "https://x.dev");
  await locks.lock(repo, "/proj/inner/", undefined, "https://x.dev");
  await locks.lock(repo, "/other/", undefined, "https://x.dev");
  const gone = await locks.unlockUnder(repo, "/proj/");
  assert.deepEqual(gone.sort(), ["/proj/", "/proj/inner/"]);
  assert.deepEqual(Object.keys(await locks.load(repo)), ["/other/"]);
  assert.equal(store.recall(repo, "/proj/inner/"), null);
  assert.equal(store.recall(repo, "/other/"), await Promise.resolve(store.recall(repo, "/other/")));
  assert.ok(store.recall(repo, "/other/"), "an unrelated lock must survive");
});

test("a lock with no stored password is reported, not silently blank", async () => {
  const repo = scaffold();
  await locks.lock(repo, "/elsewhere/", undefined, "https://x.dev");
  store.forget(repo, "/elsewhere/"); // as if locked on another machine
  assert.equal(store.recall(repo, "/elsewhere/"), null);
  assert.ok("/elsewhere/" in (await locks.load(repo)), "the lock itself remains");
});
