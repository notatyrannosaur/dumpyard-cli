#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename, extname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, isPlaceholder } from "../src/config.mjs";
import { build, urlOf } from "../src/build.mjs";
import * as locks from "../src/locks.mjs";
import * as store from "../src/store.mjs";
import { wranglerProblem } from "../src/wrangler.mjs";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATES = join(PKG, "templates");

// Pinned: @latest would let a Cloudflare release break publishing overnight
// with no change on our side. Bump deliberately, after running the tests.
const WRANGLER = "wrangler@4.134.0";

// [template, destination]. Worker code is always refreshed; it is ours.
const CODE = [["worker/index.js"], ["worker/hash.js"]];
// Machine-facing text: refreshed by `upgrade`, seeded by `init`.
const MACHINE = [["llms.txt"], ["public/robots.txt"], ["public/404.html"]];
// Yours once created: locks.js holds real hashes, the rest you may edit.
// npm strips files named .gitignore from packages, hence the rename.
const ONCE = [["worker/locks.js"], ["wrangler.jsonc"], ["README.md"], ["gitignore", ".gitignore"]];

const help = () => `dumpyard — publish pages, notes, PDFs and images, each folder behind its own password

  dumpyard publish <file|dir>...   add content, commit, push and deploy
    --space <name>                 folder to publish into (default: the file's name)
    --update                       add to a space that already exists
    --replace                      clear a space that already exists first
    --set-password                 lock the space (keeps its password if already locked)
    --password <value|->           lock it with your own password; - reads it from stdin
    --expires <when>               kill the link later: 30m, 12h, 7d, 2w, or a date
    --no-push                      don't push to git
    --no-deploy                    don't deploy to Cloudflare

  dumpyard remove <path>           unpublish a folder or page
  dumpyard lock <folder>           lock a folder, or rotate its password
    --password <value|->
    --expires <when>
  dumpyard unlock <folder>         make it public again
  dumpyard expire <folder> <when>  change a locked folder's expiry, or "never"
  dumpyard prune                   remove everything whose link has expired
  dumpyard list                    every lock, with its password and expiry
  dumpyard password <folder>       print one password, nothing else
  dumpyard status                  is it set up, where, what's published (no passwords)
  dumpyard build                   re-render markdown and regenerate indexes
  dumpyard deploy                  deploy to Cloudflare with wrangler
  dumpyard init --repo <path>      scaffold a content repo and remember it
    --url <https://...>            the site's public base URL
  dumpyard upgrade                 refresh the gate and llms.txt from this CLI
  dumpyard install-skill [--dir <path>]   copy the agent skill into ~/.claude/skills

  Any command:  --repo <path>  use this site instead of the remembered one
                -m, --message <text>  commit message

Every command that changes the site commits, pushes and deploys, unless told
not to. Paths may be written /space/, space/ or space.

Passwords are three random words, e.g. orbit-cactus-mellow. They are kept in
  ${store.storePath()}
(mode 0600; set DUMPYARD_HOME to move it) so they can be read back, and never
written into the repo, so they are never deployed.

Expiry applies to locked folders only. An expired link returns 410 to everyone,
even with the right password; \`prune\` then removes the content itself.
`;

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        space: { type: "string" },
        password: { type: "string" },
        "set-password": { type: "boolean" },
        expires: { type: "string" },
        update: { type: "boolean" },
        replace: { type: "boolean" },
        "no-push": { type: "boolean" },
        "no-deploy": { type: "boolean" },
        repo: { type: "string" },
        url: { type: "string" },
        dir: { type: "string" },
        message: { type: "string", short: "m" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    // parseArgs' own messages are fine; its stack trace is not.
    throw new Error(`${err.message.split("\n")[0]}\n\nRun \`dumpyard --help\` for the options.`);
  }
}

// Set by main() once the arguments parse.
let flags, command, args;

const git = (repo, ...a) =>
  execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const slug = (s) =>
  basename(s, extname(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const expiryNote = (lock) =>
  !lock?.expires ? "" : locks.isExpired(lock) ? "EXPIRED" : `expires ${when(lock.expires)}`;

// Turn anything a user or agent types into a path strictly inside public/.
// This is the only way a path reaches rmSync: `remove ..` used to delete the
// whole repo, and `remove ../..` the folder above it.
function sitePath(repo, input) {
  const rel = String(input ?? "").replace(/^\/+|\/+$/g, "");
  if (!rel) throw new Error("needs a path inside the site, e.g. /project-xyz/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === ".." || /[\\\0]/.test(seg)) {
      throw new Error(`bad path "${input}" — use a folder or page inside the site, e.g. /project-xyz/`);
    }
  }
  const root = resolve(repo, "public");
  const abs = resolve(root, rel);
  if (!abs.startsWith(root + sep)) throw new Error(`bad path "${input}" — it points outside the site`);
  return { rel, abs, key: `/${rel}/` };
}

// Locks go on folders only. A lock on a single page left its .md source
// served beside it, readable without the password.
function lockableFolder(repo, input) {
  const p = sitePath(repo, input);
  if (!existsSync(p.abs) || !statSync(p.abs).isDirectory()) {
    throw new Error(
      `${p.key} isn't a published folder. Only folders can be locked — lock the folder that holds it, ` +
        "or publish the page into a space of its own.",
    );
  }
  return p;
}

// Check git can commit before touching anything, so a missing identity can't
// leave half a change behind.
function preflight(repo) {
  const env = process.env;
  for (const [key, a, c] of [["user.name", "GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"], ["user.email", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]]) {
    if (env[a] && env[c]) continue;
    try {
      if (git(repo, "config", key)) continue;
    } catch {
      // unset
    }
    throw new Error(`git has no ${key} set, so dumpyard can't commit. Set it with: git config --global ${key} "..."`);
  }
}

async function main() {
  const parsed = parse();
  flags = parsed.values;
  [command, ...args] = parsed.positionals;
  if (flags.help || !command || command === "help") return void console.log(help());
  // "-" reads the password from stdin, keeping it out of shell history and ps.
  if (flags.password === "-") flags.password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  locks.checkChosen(flags.password);

  if (command === "install-skill") {
    const dir = resolve(flags.dir ?? join(homedir(), ".claude", "skills", "dumpyard"));
    mkdirSync(dir, { recursive: true });
    cpSync(join(PKG, "skills", "dumpyard", "SKILL.md"), join(dir, "SKILL.md"));
    return void console.log(`installed ${join(dir, "SKILL.md")}`);
  }

  if (command === "init") return init();

  if (command === "upgrade") {
    const repo = resolve(flags.repo ?? loadConfig().repo);
    preflight(repo);
    for (const [src, dest = src] of [...CODE, ...MACHINE]) place(repo, src, dest);
    for (const [src, dest = src] of ONCE) if (!existsSync(join(repo, dest))) place(repo, src, dest);
    // llms.txt used to be served publicly from public/; it now lives at the root.
    if (existsSync(join(repo, "public", "llms.txt"))) rmSync(join(repo, "public", "llms.txt"));
    await build(repo, { quiet: true });
    console.log(`refreshed the gate and llms.txt in ${repo}`);
    return (await ship(repo, loadConfig({ repo }).url, "upgrade dumpyard")).code;
  }

  const { repo, url } = loadConfig({ repo: flags.repo, url: flags.url });

  if (command === "status") return void (await status(repo, url));

  if (command === "list") {
    const table = await locks.load(repo);
    const paths = Object.keys(table).sort();
    if (!paths.length) return void console.log("nothing is locked");
    const width = Math.max(...paths.map((p) => p.length));
    for (const p of paths) {
      const pw = store.recall(repo, p) ?? "(password not stored on this machine)";
      console.log(`${p.padEnd(width)}  ${pw}  ${expiryNote(table[p])}`.trimEnd());
    }
    return;
  }

  if (command === "password") {
    const { key } = sitePath(repo, args[0]);
    const pw = store.recall(repo, key);
    if (!pw) {
      const locked = key in (await locks.load(repo));
      throw new Error(locked ? `${key} is locked, but its password isn't stored on this machine` : `${key} is not locked`);
    }
    return void console.log(pw);
  }

  if (command === "build") return void (await build(repo));
  if (command === "deploy") return (await deploy(repo, url, { echo: true })) ? 0 : 2;

  if (command === "unlock") {
    const { key } = sitePath(repo, args[0]);
    preflight(repo);
    await locks.unlock(repo, key);
    await build(repo, { quiet: true });
    console.log(`unlocked ${key} — it is public once deployed`);
    return (await ship(repo, url, `unlock ${key.slice(1, -1)}`)).code;
  }

  if (command === "lock") {
    const { key } = lockableFolder(repo, args[0]);
    if (flags.expires) locks.parseWhen(flags.expires); // validate before changing anything
    preflight(repo);
    const { password, rotated } = await locks.lock(repo, key, flags.password, url);
    if (flags.expires) await locks.setExpiry(repo, key, flags.expires);
    await build(repo, { quiet: true });
    console.log(rotated ? `ROTATED ${key}: the old password stops working once this deploys` : `locked ${key}`);
    console.log(`password: ${password}   (readable later with \`dumpyard password ${key}\`)`);
    const lock = (await locks.load(repo))[key];
    if (lock?.expires) console.log(`expires:  ${when(lock.expires)}`);
    return (await ship(repo, url, `${rotated ? "rotate" : "lock"} ${key.slice(1, -1)}`)).code;
  }

  if (command === "expire") {
    if (!args[1]) throw new Error("expire needs a folder and a time, e.g. `dumpyard expire /x/ 7d`");
    const { key } = sitePath(repo, args[0]);
    preflight(repo);
    const at = await locks.setExpiry(repo, key, args[1]);
    console.log(at === null ? `${key} no longer expires` : `${key} expires ${when(at)}`);
    return (await ship(repo, url, `expiry ${key.slice(1, -1)}`)).code;
  }

  if (command === "prune") {
    const table = await locks.load(repo);
    const expired = Object.keys(table).filter((p) => locks.isExpired(table[p]));
    // An expired folder can hold a sub-folder with its own, still-live lock.
    // Deleting the parent would kill that too, so leave it and say why.
    const keep = expired.filter((p) =>
      Object.keys(table).some((q) => q !== p && q.startsWith(p) && !locks.isExpired(table[q])),
    );
    for (const p of keep) console.warn(`skipped ${p}: it contains a lock that hasn't expired`);
    const targets = expired.filter((p) => !keep.includes(p));
    if (!targets.length) return void console.log("nothing has expired");
    preflight(repo);
    return unpublish(repo, url, targets.map((t) => sitePath(repo, t)), "prune expired");
  }

  if (command === "remove") {
    const target = sitePath(repo, args[0]);
    preflight(repo);
    return unpublish(repo, url, [target], flags.message ?? `remove ${target.rel}`);
  }

  if (command === "publish") return publish(repo, url);
  throw new Error(`unknown command "${command}"\n\n${help()}`);
}

async function init() {
  const repo = resolve(flags.repo ?? process.cwd());
  // A repo containing the local store would commit, push and deploy it.
  if (store.wouldContainStore(repo)) {
    throw new Error(`refusing: ${repo} would contain dumpyard's password store (${store.home()})`);
  }
  mkdirSync(repo, { recursive: true });
  const fresh = !existsSync(join(repo, "wrangler.jsonc"));
  for (const [src, dest = src] of [...CODE, ...MACHINE, ...ONCE]) {
    if (CODE.some(([c]) => c === src) || !existsSync(join(repo, dest))) place(repo, src, dest);
  }
  if (fresh) nameProject(repo);
  if (!existsSync(join(repo, ".git"))) {
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    console.log("initialised a git repo");
  }
  await build(repo, { quiet: true });
  // Keep a known URL only when re-initialising the same repo; a new site must
  // not inherit another site's address.
  const prev = loadConfigSafe();
  const same = prev && resolve(prev.repo) === repo;
  const url = flags.url ?? (same ? prev.url : undefined);
  console.log(`scaffolded ${repo}\nremembered in ${saveConfig({ repo, url: url ?? undefined })}`);
  if (prev && !same) {
    console.log(`note: dumpyard now points at this site, not ${prev.repo}. Use --repo or DUMPYARD_HOME to work with both.`);
  }
  if (!flags.url && !same) console.log("next: `dumpyard deploy` publishes it and records its URL");
}

async function publish(repo, url) {
  if (!args.length) throw new Error("publish needs at least one file or directory");
  const space = flags.space ?? slug(args[0]);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(space)) {
    throw new Error(`bad space name "${space}" — lowercase letters, digits and dashes only`);
  }
  const path = `/${space}/`;
  const dest = join(repo, "public", space);
  const existed = existsSync(dest);

  // Everything that can fail is checked before the repo is touched. A publish
  // that dies halfway must never leave unlocked content behind for the next
  // commit to ship.
  if (flags.update && flags.replace) throw new Error("use --update or --replace, not both");
  if (existed && !flags.update && !flags.replace) {
    throw new Error(
      `${path} already exists. Add --update to add to it, or --replace to clear it first. ` +
        "Nothing was changed.",
    );
  }
  for (const src of args) if (!existsSync(src)) throw new Error(`no such file: ${src}`);
  const table = await locks.load(repo);
  const alreadyLocked = path in table;
  const wantsLock = Boolean(flags.password || flags["set-password"]);
  if (flags.expires) {
    locks.parseWhen(flags.expires);
    if (!wantsLock && !alreadyLocked) {
      throw new Error(`--expires needs a locked folder — add --set-password (${path} is public)`);
    }
  }
  if (wantsLock) await locks.pepperFor(repo); // fails early on a machine without the site's pepper
  preflight(repo);

  // A lone page published without --space is the folder's page, so the link
  // you get is /name/, not /name/name.
  const single = args.length === 1 && !statSync(args[0]).isDirectory();
  const asIndex = single && !flags.space && /\.(html|md)$/i.test(args[0]);

  pull(repo);

  // Lock first. If anything below fails, the worst case is locked content,
  // never public content. --set-password on a space that's already locked
  // keeps its password: people you sent the link to shouldn't be locked out by
  // an update. Only an explicit --password (or `lock`) changes it.
  let lockedNow = false;
  if (flags.password || (flags["set-password"] && !alreadyLocked)) {
    const { rotated } = await locks.lock(repo, path, flags.password, url);
    lockedNow = !rotated;
    if (rotated) console.log(`ROTATED ${path}: the old password stops working once this deploys`);
  } else if (flags["set-password"]) {
    console.log(`${path} is already locked — keeping its password`);
  }
  if (flags.expires) await locks.setExpiry(repo, path, flags.expires);

  let placed;
  try {
    if (existed && flags.replace) {
      rmSync(dest, { recursive: true, force: true });
      console.log(`cleared ${path}`);
    }
    mkdirSync(dest, { recursive: true });
    for (const src of args) {
      const isDir = statSync(src).isDirectory();
      const name = asIndex ? `index${extname(src).toLowerCase()}` : basename(src);
      cpSync(src, isDir ? dest : join(dest, name), { recursive: true });
      console.log(`added ${space}/${isDir ? "" : name}`);
      placed = name;
    }
    const { warnings } = await build(repo, { quiet: true });
    reportWarnings(warnings, `${space}/`);
  } catch (err) {
    if (!existed) {
      rmSync(dest, { recursive: true, force: true });
      if (lockedNow) await locks.unlock(repo, path).catch(() => {});
    }
    throw err;
  }

  const { deployed } = await ship(repo, url, flags.message ?? `publish ${space}`, { quiet: true });
  const live = loadConfig({ repo }).url; // deploy may have just learned it

  // The link to hand over: the page itself when one file was published under
  // an explicit space, otherwise the folder.
  const link = single && !asIndex ? `${live}${encodeURI(urlOf(`${space}/${placed}`))}` : `${live}${path}`;
  const password = store.recall(repo, path);
  const lock = (await locks.load(repo))[path];
  console.log(`\n${link}`);
  if (password) console.log(`password: ${password}   (any username works at the prompt)`);
  if (lock?.expires) console.log(`expires:  ${when(lock.expires)}`);
  if (password) console.log("Locked areas are left off the public index, so send the link directly.");
  return verdict(deployed, { placeholder: isPlaceholder(live) });
}

// Delete one or more folders/pages, drop their locks and passwords, ship.
async function unpublish(repo, url, targets, message) {
  const root = resolve(repo, "public");
  pull(repo);
  let changed = false;
  for (const { abs, key } of targets) {
    // A page may be the markdown source, the rendered html, or a whole folder.
    for (const f of [abs, `${abs}.md`, `${abs}.html`]) {
      if (!existsSync(f)) continue;
      if (!resolve(f).startsWith(root + sep)) throw new Error(`refusing to delete ${f}: outside the site`);
      rmSync(f, { recursive: true, force: true });
      console.log(`removed ${f.slice(root.length + 1)}`);
      changed = true;
    }
    // Also clears a lock left dangling after its content was deleted by hand.
    for (const p of await locks.unlockUnder(repo, key)) {
      console.log(`dropped lock ${p}`);
      changed = true;
    }
  }
  if (!changed) throw new Error(`nothing published at ${targets[0].key}`);
  await build(repo, { quiet: true });
  const { code, deployed } = await ship(repo, url, message);
  if (deployed) for (const t of targets) console.log(`${loadConfig({ repo }).url}${t.key} is gone. It is still in git history.`);
  return code;
}

// Commit, push, deploy. Returns { code, deployed }.
async function ship(repo, url, message, { quiet = false } = {}) {
  commit(repo, message);
  if (!flags["no-push"]) push(repo);
  const deployed = flags["no-deploy"] ? null : await deploy(repo, url, { echo: isPlaceholder(url) });
  if (quiet) return { code: null, deployed };
  return { code: verdict(deployed), deployed };
}

// null = deploy skipped on purpose, true = live, false = tried and failed.
function verdict(deployed, { placeholder = false } = {}) {
  if (deployed === true) {
    console.log("\nDeployed. Live now.");
    return 0;
  }
  if (deployed === null) {
    console.log("\nNot deployed (--no-deploy). None of this is live until you run `dumpyard deploy`.");
    if (placeholder) console.log("The URL above is a placeholder; the first deploy prints the real one.");
    return 0;
  }
  console.log("\nNOT DEPLOYED. The change is committed locally but is not live. Fix the error above, then `dumpyard deploy`.");
  return 2;
}

function reportWarnings(warnings, scope) {
  const mine = warnings.filter((w) => w.from.startsWith(scope));
  for (const w of mine) console.warn(`  warn: ${w.from}: ${w.message}`);
  const others = warnings.length - mine.length;
  if (others) console.warn(`  (${others} warning(s) elsewhere on the site — \`dumpyard build\` lists them)`);
}

async function status(repo, url) {
  const table = await locks.load(repo);
  const root = join(repo, "public");
  const spaces = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const lockPaths = Object.keys(table);
  const expired = lockPaths.filter((p) => locks.isExpired(table[p]));
  const stored = lockPaths.filter((p) => store.recall(repo, p));
  const pep = store.pepper(repo);
  console.log(`repo:      ${repo}`);
  console.log(`site:      ${isPlaceholder(url) ? "not deployed yet — run `dumpyard deploy`" : url}`);
  console.log(`spaces:    ${spaces.length ? spaces.map((s) => `/${s}/${`/${s}/` in table ? " (locked)" : ""}`).join("  ") : "none"}`);
  console.log(`locks:     ${lockPaths.length}${expired.length ? ` (${expired.length} expired — \`dumpyard prune\`)` : ""}`);
  console.log(`passwords: ${stored.length} of ${lockPaths.length} stored in ${store.storePath()}`);
  console.log(
    `pepper:    ${
      pep
        ? pep.uploaded
          ? "on this machine and in Cloudflare"
          : "on this machine; uploaded on the next deploy"
        : lockPaths.length
          ? "MISSING on this machine — locks can't be made or checked here"
          : "none yet (the first lock creates it)"
    }`,
  );
  const gone = store.orphans();
  if (gone.length) console.log(`note:      stored secrets for ${gone.length} site(s) whose folder is gone: ${gone.join(", ")}`);
}

// Copy one template into the repo, creating its folder.
function place(repo, src, dest = src) {
  const to = join(repo, dest);
  mkdirSync(join(to, ".."), { recursive: true });
  cpSync(join(TEMPLATES, src), to);
}

// The Worker is named after the folder, prefixed so it can't collide with a
// Worker you already have: `wrangler deploy` replaces a same-named Worker.
function nameProject(repo) {
  const file = join(repo, "wrangler.jsonc");
  const base = basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "site";
  const name = base.startsWith("dumpyard") ? base : `dumpyard-${base}`;
  writeFileSync(file, readFileSync(file, "utf8").replace(/"name":\s*"[^"]*"/, `"name": "${name}"`));
}

const loadConfigSafe = () => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
};

// Run the pinned wrangler in the repo. Streams output when asked (always on the
// first deploy, which may need your input). `input` is written to its stdin.
function wrangler(repo, argv, { echo = false, input } = {}) {
  return new Promise((done) => {
    let out = "";
    const child = spawn("npx", ["--yes", WRANGLER, ...argv], {
      cwd: repo,
      stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    });
    const tap = (stream) => (d) => {
      out += d;
      if (echo) stream.write(d);
    };
    child.stdout.on("data", tap(process.stdout));
    child.stderr.on("data", tap(process.stderr));
    child.on("error", (err) => done({ code: 1, out: out + err.message }));
    child.on("close", (code) => done({ code, out }));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function deploy(repo, url, { echo }) {
  const problem = wranglerProblem(repo);
  if (problem) {
    console.error(`\nrefusing to deploy: ${problem}`);
    return false;
  }
  const r = await wrangler(repo, ["deploy"], { echo });
  if (r.code !== 0) {
    if (!echo) process.stderr.write(r.out.trim().split("\n").slice(-6).join("\n") + "\n");
    const hint = /not logged in|authenticat|credential|API token|OAuth/i.test(r.out)
      ? `run \`npx ${WRANGLER} login\` once, then \`dumpyard deploy\``
      : /subdomain/i.test(r.out)
        ? `your Cloudflare account has no workers.dev subdomain yet — run \`npx ${WRANGLER} deploy\` once inside ${repo} and pick one, then \`dumpyard deploy\``
        : null;
    if (hint) console.error(`\n${hint}`);
    return false;
  }
  // Only replace a workers.dev (or placeholder) URL — never a custom domain
  // you set on purpose, or every deploy would quietly revert it.
  const live = r.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0];
  if (live && live !== url && (isPlaceholder(url) || /\.workers\.dev$/.test(url))) {
    saveConfig({ repo, url: live });
    console.log(`\nsite URL recorded: ${live}`);
  }
  return ensurePepper(repo);
}

// Make sure Cloudflare has this site's pepper. Without it every locked page
// answers 503: safe, but useless. Secrets can't be read back from Cloudflare,
// so a pepper not yet marked uploaded is always (re)written.
async function ensurePepper(repo) {
  const pep = store.pepper(repo);
  const hasLocks = Object.keys(await locks.load(repo)).length > 0;
  if (!pep) {
    if (!hasLocks) return true;
    console.error("\nthis site's pepper isn't on this machine, so its locked pages can't be checked. Copy it from the machine that set the site up.");
    return false;
  }
  if (pep.uploaded) {
    const list = await wrangler(repo, ["secret", "list", "--format", "json"]);
    const json = list.out.slice(list.out.indexOf("["), list.out.lastIndexOf("]") + 1);
    let names = [];
    try {
      names = JSON.parse(json).map((s) => s.name);
    } catch {
      // unreadable list: fall through and write it again
    }
    if (list.code === 0 && names.includes("DUMPYARD_PEPPER")) return true;
  }
  const put = await wrangler(repo, ["secret", "put", "DUMPYARD_PEPPER"], { input: pep.value });
  if (put.code !== 0) {
    process.stderr.write(put.out.trim().split("\n").slice(-6).join("\n") + "\n");
    console.error("\ncould not upload the site's pepper (DUMPYARD_PEPPER); locked pages answer 503 until it's there.");
    return false;
  }
  store.markPepperUploaded(repo);
  console.log("uploaded the site's pepper to Cloudflare (DUMPYARD_PEPPER)");
  return true;
}

function commit(repo, message) {
  git(repo, "add", "-A");
  // Skip only when there is genuinely nothing staged. Any other failure (no
  // git identity, a hook) is real and must not be swallowed.
  if (!git(repo, "status", "--porcelain")) return;
  try {
    git(repo, "commit", "-q", "-m", message);
  } catch (err) {
    throw new Error(`git commit failed — ${String(err.stderr || err.message).trim().split("\n")[0]}`);
  }
}

function pull(repo) {
  try {
    if (git(repo, "remote")) git(repo, "pull", "--ff-only", "-q");
  } catch {
    console.warn("warn: could not pull; continuing with the local copy");
  }
}

function push(repo) {
  try {
    if (!git(repo, "remote")) return false;
    git(repo, "push", "-q");
    return true;
  } catch (err) {
    console.warn(`warn: push failed — ${String(err.stderr || err.message).trim().split("\n")[0]}`);
    return false;
  }
}

// Exit codes: 0 ok, 1 error, 2 the change was made but is NOT live.
try {
  process.exitCode = (await main()) ?? 0;
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}
