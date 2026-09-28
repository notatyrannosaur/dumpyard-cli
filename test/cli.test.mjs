// Drives the real CLI against throwaway repos. Never pushes or deploys: every
// ship passes --no-push --no-deploy, except the deploy-failure test, which puts
// a fake `npx` first on PATH so nothing can reach Cloudflare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/dumpyard.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const GIT_ID = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function site() {
  const home = tmp("dy-home-");
  const repo = join(tmp("dy-site-"), "site");
  const run = (argv, env = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...argv, "--repo", repo], {
      encoding: "utf8",
      env: { ...process.env, ...GIT_ID, DUMPYARD_HOME: home, ...env },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  assert.equal(run(["init", "--url", "https://t.example.workers.dev"]).code, 0);
  const ship = ["--no-push", "--no-deploy"];
  return { repo, home, run, ship, pub: (rel) => join(repo, "public", rel) };
}
const file = (name, text) => {
  const d = tmp("dy-src-");
  const f = join(d, name);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
  return f;
};
const folder = (files) => {
  const d = tmp("dy-src-");
  for (const [n, t] of Object.entries(files)) {
    mkdirSync(join(d, n, ".."), { recursive: true });
    writeFileSync(join(d, n), t);
  }
  return d;
};

test("a failed locked publish leaves nothing that a later publish could ship publicly", () => {
  const s = site();
  const r = s.run(["publish", file("secret.md", "# Secret\n"), "--space", "leak", "--password", "short", ...s.ship]);
  assert.equal(r.code, 1);
  assert.match(r.out, /at least 12 characters/);
  assert.ok(!existsSync(s.pub("leak")), "content must not be left behind");
  // The follow-up publish that used to sweep it up, unlocked, and list it.
  assert.equal(s.run(["publish", file("other.md", "# Other\n"), "--space", "other", ...s.ship]).code, 0);
  assert.ok(!existsSync(s.pub("leak")));
  assert.doesNotMatch(readFileSync(s.pub("index.html"), "utf8"), /leak/);
});

test("your own index.html is kept, not replaced by a listing", () => {
  const s = site();
  const app = folder({ "index.html": "<title>My App</title><h1>MY APP</h1>", "app.js": "1" });
  assert.equal(s.run(["publish", app, "--space", "app", ...s.ship]).code, 0);
  assert.match(readFileSync(s.pub("app/index.html"), "utf8"), /MY APP/);
  assert.equal(s.run(["build"]).code, 0);
  assert.match(readFileSync(s.pub("app/index.html"), "utf8"), /MY APP/, "and survives a rebuild");
});

test("a lone page without --space is served at /name/, and that's the link printed", () => {
  const s = site();
  const r = s.run(["publish", file("report.html", "<title>R</title>REPORT"), ...s.ship]);
  assert.equal(r.code, 0);
  assert.match(readFileSync(s.pub("report/index.html"), "utf8"), /REPORT/);
  assert.match(r.out, /\nhttps:\/\/t\.example\.workers\.dev\/report\/\n/);
});

test("a single file into a named space prints the file's own URL", () => {
  const s = site();
  const r = s.run(["publish", file("My Report.pdf", "%PDF"), "--space", "docs", ...s.ship]);
  assert.match(r.out, /\/docs\/My%20Report\.pdf\n/);
  assert.match(readFileSync(s.pub("docs/index.html"), "utf8"), /href="\/docs\/My%20Report\.pdf"/, "and the listing encodes it");
});

test("republishing merges; --replace clears first", () => {
  const s = site();
  s.run(["publish", folder({ "a.md": "# A\n", "b.md": "# B\n" }), "--space", "p", ...s.ship]);
  const merged = s.run(["publish", folder({ "a.md": "# A2\n" }), "--space", "p", ...s.ship]);
  assert.match(merged.out, /updating existing \/p\//);
  assert.ok(existsSync(s.pub("p/b.md")), "merge keeps b");
  s.run(["publish", folder({ "a.md": "# A3\n" }), "--space", "p", "--replace", ...s.ship]);
  assert.ok(!existsSync(s.pub("p/b.md")) && !existsSync(s.pub("p/b.html")), "replace removes b and its output");
});

test("removing a folder's only page leaves no empty folder on the index", () => {
  const s = site();
  s.run(["publish", folder({ "only.md": "# Only\n" }), "--space", "solo", ...s.ship]);
  assert.equal(s.run(["remove", "solo/only", ...s.ship]).code, 0);
  assert.ok(!existsSync(s.pub("solo")), "folder is gone");
  assert.doesNotMatch(readFileSync(s.pub("index.html"), "utf8"), /solo/);
});

test("a plain link from a public page into a locked folder is flagged", () => {
  const s = site();
  s.run(["publish", folder({ "x.md": "# X\n" }), "--space", "vault", "--set-password", ...s.ship]);
  const r = s.run(["publish", folder({ "n.md": "# N\n\n[secret](/vault/x)\n" }), "--space", "open", ...s.ship]);
  assert.match(r.out, /open\/n\.md: links to \/vault\/x, which is locked/);
});

test("--no-deploy says nothing is live; a failed deploy exits 2 and says NOT DEPLOYED", () => {
  const s = site();
  const skipped = s.run(["publish", file("a.md", "# A\n"), "--space", "a", ...s.ship]);
  assert.equal(skipped.code, 0);
  assert.match(skipped.out, /Not deployed \(--no-deploy\)/);

  const bin = tmp("dy-fakebin-");
  writeFileSync(join(bin, "npx"), "#!/bin/sh\necho 'something broke' >&2\nexit 1\n");
  chmodSync(join(bin, "npx"), 0o755);
  const failed = s.run(["publish", file("b.md", "# B\n"), "--space", "b", "--no-push"], {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(failed.code, 2, "an agent must be able to tell from the exit code");
  assert.match(failed.out, /NOT DEPLOYED/);
  assert.doesNotMatch(failed.out, /Live now/);
});

test("status reports the setup without printing any password", () => {
  const s = site();
  const pub = s.run(["publish", file("a.md", "# A\n"), "--space", "sec", "--set-password", ...s.ship]);
  const pw = /password: (\S+)/.exec(pub.out)[1];
  const st = s.run(["status"]);
  assert.equal(st.code, 0);
  assert.match(st.out, /\/sec\//);
  assert.ok(!st.out.includes(pw), "status must not leak passwords");
});

test("lock, unlock and expire commit, and accept paths without slashes", () => {
  const s = site();
  s.run(["publish", file("a.md", "# A\n"), "--space", "zed", ...s.ship]);
  const commits = () => spawnSync("git", ["-C", s.repo, "log", "--oneline"], { encoding: "utf8" }).stdout;
  assert.equal(s.run(["lock", "zed", ...s.ship]).code, 0);
  assert.match(commits(), /lock zed/);
  assert.equal(s.run(["password", "zed"]).code, 0);
  assert.equal(s.run(["expire", "zed/", "3d", ...s.ship]).code, 0);
  assert.match(commits(), /expiry zed/);
  assert.equal(s.run(["unlock", "/zed", ...s.ship]).code, 0);
  assert.match(commits(), /unlock zed/);
});

test("mistakes get one-line errors, not stack traces", () => {
  const s = site();
  const typo = s.run(["publish", "x", "--set-pasword"]);
  assert.equal(typo.code, 1);
  assert.match(typo.out, /Unknown option '--set-pasword'/);
  assert.doesNotMatch(typo.out, /at parse|node:internal/);
  s.run(["publish", file("a.md", "# A\n"), "--space", "e", "--set-password", ...s.ship]);
  assert.match(s.run(["expire", "e", "7", ...s.ship]).out, /can't read "7" as an expiry/);
});

test("init scaffolds a .gitignore and a collision-safe Worker name", () => {
  const s = site();
  assert.match(readFileSync(join(s.repo, ".gitignore"), "utf8"), /^\.wrangler\/$/m);
  assert.match(readFileSync(join(s.repo, "wrangler.jsonc"), "utf8"), /"name": "dumpyard-site"/);
  assert.ok(!existsSync(join(s.repo, "public", "llms.txt")), "llms.txt is not served publicly");
  assert.ok(existsSync(join(s.repo, "llms.txt")));
});

test("install-skill copies SKILL.md where you point it", () => {
  const dir = join(tmp("dy-skill-"), "dumpyard");
  const r = spawnSync(process.execPath, [BIN, "install-skill", "--dir", dir], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /^---\nname: dumpyard/);
});

test("a second site does not inherit the first site's URL", () => {
  const s = site(); // first site, with a real-looking URL
  const other = join(tmp("dy-site2-"), "other");
  const r = spawnSync(process.execPath, [BIN, "init", "--repo", other], {
    encoding: "utf8", env: { ...process.env, ...GIT_ID, DUMPYARD_HOME: s.home },
  });
  assert.equal(r.status, 0);
  const st = spawnSync(process.execPath, [BIN, "status", "--repo", other], {
    encoding: "utf8", env: { ...process.env, DUMPYARD_HOME: s.home },
  });
  assert.match(st.stdout, /not deployed yet/);
  assert.doesNotMatch(st.stdout, /t\.example\.workers\.dev/);
});
