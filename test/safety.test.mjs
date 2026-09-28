// Regression tests for the second newcomer audit. Each drives the real CLI
// against throwaway repos; nothing here can reach Cloudflare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../src/wrangler.mjs";

const BIN = fileURLToPath(new URL("../bin/dumpyard.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const GIT_ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const SHIP = ["--no-push", "--no-deploy"];

function site({ parent } = {}) {
  const home = tmp("dy-home-");
  const repo = join(parent ?? tmp("dy-site-"), "site");
  const run = (argv, { env = {}, input } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...argv, "--repo", repo], {
      encoding: "utf8",
      input,
      env: { ...process.env, ...GIT_ID, DUMPYARD_HOME: home, ...env },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  assert.equal(run(["init", "--url", "https://t.example.workers.dev"]).code, 0);
  const pw = (key) => run(["password", key]).out.trim();
  return { repo, home, run, pw, pub: (rel) => join(repo, "public", rel) };
}
const folder = (files) => {
  const d = tmp("dy-src-");
  for (const [n, t] of Object.entries(files)) {
    mkdirSync(join(d, n, ".."), { recursive: true });
    writeFileSync(join(d, n), t);
  }
  return d;
};

// A fake `npx` that logs each wrangler call, and what arrived on stdin.
function fakeWrangler() {
  const dir = tmp("dy-fake-");
  const script = `#!/bin/sh
shift 2   # drop "--yes wrangler@x"
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "deploy "*|"deploy") echo "Deployed https://dumpyard-site.fake.workers.dev" ;;
  "secret list") if [ -f "${dir}/has-pepper" ]; then echo '[{"name":"DUMPYARD_PEPPER","type":"secret_text"}]'; else echo '[]'; fi ;;
  "secret put") cat > "${dir}/pepper"; touch "${dir}/has-pepper" ;;
esac
`;
  writeFileSync(join(dir, "npx"), script);
  chmodSync(join(dir, "npx"), 0o755);
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []);
  return { env: { PATH: `${dir}:${process.env.PATH}` }, calls, dir };
}

test("remove can't escape the site: .., ../.., a/../.., / and . are refused", () => {
  const parent = tmp("dy-parent-");
  writeFileSync(join(parent, "precious.txt"), "keep me");
  const s = site({ parent });
  s.run(["publish", folder({ "a.md": "# A\n" }), "--space", "a", ...SHIP]);
  for (const bad of ["..", "../..", "a/../..", "/", ".", "a//b", "..%2f"]) {
    const r = s.run(["remove", bad, ...SHIP]);
    assert.equal(r.code, 1, `remove ${bad} must fail`);
  }
  assert.ok(existsSync(join(parent, "precious.txt")), "the parent folder survives");
  assert.ok(existsSync(join(s.repo, ".git")) && existsSync(s.pub("a/a.md")), "the repo and its content survive");
});

test("only folders can be locked, and only ones that exist", () => {
  const s = site();
  s.run(["publish", folder({ "secret-page.md": "# S\n" }), "--space", "pub", ...SHIP]);
  const page = s.run(["lock", "/pub/secret-page", ...SHIP]);
  assert.equal(page.code, 1);
  assert.match(page.out, /Only folders can be locked/);
  assert.equal(s.run(["lock", "/nothing-here/", ...SHIP]).code, 1);
});

test("--set-password on an already-locked space keeps its password; lock rotates, loudly", () => {
  const s = site();
  s.run(["publish", folder({ "a.md": "# A\n" }), "--space", "keep", "--set-password", ...SHIP]);
  const first = s.pw("/keep/");
  const again = s.run(["publish", folder({ "b.md": "# B\n" }), "--space", "keep", "--update", "--set-password", ...SHIP]);
  assert.match(again.out, /already locked — keeping its password/);
  assert.equal(s.pw("/keep/"), first, "republishing must not lock out people who have the link");
  const rot = s.run(["lock", "keep", ...SHIP]);
  assert.match(rot.out, /ROTATED \/keep\//);
  assert.notEqual(s.pw("/keep/"), first);
});

test("generated passwords are three lowercase words", () => {
  const s = site();
  s.run(["publish", folder({ "a.md": "# A\n" }), "--space", "w", "--set-password", ...SHIP]);
  assert.match(s.pw("/w/"), /^[a-z]+-[a-z]+-[a-z]+$/);
});

test("hand-picked passwords: too short or too repetitive is refused; - reads stdin", () => {
  const s = site();
  const src = folder({ "a.md": "# A\n" });
  assert.match(s.run(["publish", src, "--space", "x", "--password", "short", ...SHIP]).out, /at least 12/);
  assert.match(s.run(["publish", src, "--space", "x", "--password", "aaaaaaaaaaaa", ...SHIP]).out, /too repetitive/);
  assert.ok(!existsSync(s.pub("x")), "a refused password leaves nothing behind");
  const r = s.run(["publish", src, "--space", "x", "--password", "-", ...SHIP], { input: "from-stdin-pass\n" });
  assert.equal(r.code, 0);
  assert.equal(s.pw("/x/"), "from-stdin-pass");
});

test("no git identity: refused up front, nothing changed, no password issued", () => {
  const s = site();
  const noId = { HOME: tmp("dy-nohome-"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" };
  const r = s.run(["publish", folder({ "a.md": "# A\n" }), "--space", "nid", "--set-password", ...SHIP], { env: noId });
  assert.equal(r.code, 1);
  assert.match(r.out, /git has no user\.name set/);
  assert.ok(!existsSync(s.pub("nid")));
  assert.doesNotMatch(readFileSync(join(s.repo, "worker", "locks.js"), "utf8"), /nid/);
  assert.match(s.run(["password", "nid"]).out, /not locked/);
});

test("a second machine without the pepper can't mint a new one over existing locks", () => {
  const s = site();
  s.run(["publish", folder({ "a.md": "# A\n" }), "--space", "one", "--set-password", ...SHIP]);
  writeFileSync(join(s.home, "peppers.json"), "{}\n"); // as if on another machine
  const r = s.run(["publish", folder({ "b.md": "# B\n" }), "--space", "two", "--set-password", ...SHIP]);
  assert.equal(r.code, 1);
  assert.match(r.out, /pepper isn't on this machine/);
  assert.ok(!existsSync(s.pub("two")));
});

test("deploy uploads the pepper once, over stdin, and re-checks it afterwards", () => {
  const s = site();
  const fake = fakeWrangler();
  const r = s.run(["publish", folder({ "a.md": "# A\n" }), "--space", "p", "--set-password", "--no-push"], { env: fake.env });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fake.calls(), ["deploy", "secret put DUMPYARD_PEPPER"]);
  const pepper = JSON.parse(readFileSync(join(s.home, "peppers.json"), "utf8"))[s.repo].value;
  assert.equal(readFileSync(join(fake.dir, "pepper"), "utf8"), pepper, "the pepper goes over stdin, never argv");
  assert.equal(s.run(["deploy"], { env: fake.env }).code, 0);
  assert.deepEqual(fake.calls().slice(2), ["deploy", "secret list --format json"], "already there: not rewritten");
  assert.ok(!readFileSync(join(s.repo, "worker", "locks.js"), "utf8").includes(pepper), "the pepper never enters the repo");
});

test("deploy refuses a site config without run_worker_first, before running wrangler", () => {
  const s = site();
  const fake = fakeWrangler();
  const cfg = join(s.repo, "wrangler.jsonc");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace('"run_worker_first": true', '"run_worker_first": false'));
  const r = s.run(["deploy"], { env: fake.env });
  assert.equal(r.code, 2);
  assert.match(r.out, /refusing to deploy: .*run_worker_first/);
  assert.deepEqual(fake.calls(), [], "wrangler must not have been called");
});

test("the site config check reads JSONC: comments, trailing commas, strings with //", () => {
  const cfg = parseJsonc('{\n  // a comment\n  "name": "x", /* block */\n  "url": "https://a//b",\n  "assets": { "run_worker_first": true, },\n}');
  assert.equal(cfg.url, "https://a//b");
  assert.equal(cfg.assets.run_worker_first, true);
});

test("wikilinks resolve in the note's own folder first, whatever else is published", () => {
  const s = site();
  s.run(["publish", folder({ "index.md": "# Notes Home\n", "details.md": "# Details\n\n[[index]]\n" }), "--space", "notes", ...SHIP]);
  s.run(["publish", folder({ "index.html": "<title>App</title>APP" }), "--space", "app", "--set-password", ...SHIP]);
  const html = readFileSync(s.pub("notes/details.html"), "utf8");
  assert.match(html, /<a href="\/notes\/">Notes Home<\/a>/);
});

test("an app folder with its own index.html gets no generated listings inside it", () => {
  const s = site();
  s.run(["publish", folder({ "index.html": "<title>App</title>", "js/app.js": "1" }), "--space", "app", ...SHIP]);
  assert.ok(!existsSync(s.pub("app/js/index.html")));
  assert.deepEqual(readdirSync(s.pub("app/js")), ["app.js"]);
});

test("init tells you when it repoints dumpyard at a different site", () => {
  const s = site();
  const other = join(tmp("dy-site2-"), "other");
  const r = spawnSync(process.execPath, [BIN, "init", "--repo", other], {
    encoding: "utf8", env: { ...process.env, ...GIT_ID, DUMPYARD_HOME: s.home },
  });
  assert.match(r.stdout, /now points at this site, not .*site/);
});

test("--help shows the store that is actually in use", () => {
  const home = tmp("dy-home-");
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", env: { ...process.env, DUMPYARD_HOME: home } });
  assert.ok(r.stdout.includes(join(home, "passwords.json")));
});
