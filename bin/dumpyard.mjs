#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, isPlaceholder } from "../src/config.mjs";
import { build, urlOf } from "../src/build.mjs";
import * as locks from "../src/locks.mjs";
import * as store from "../src/store.mjs";

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

const HELP = `dumpyard — publish pages, notes, PDFs and images, each path behind its own password

  dumpyard publish <file|dir>...   add content, commit, push and deploy
    --space <name>                 folder to publish into (default: the file's name)
    --set-password                 lock the space with a generated password
    --password <value>             lock it with your own (12+ characters)
    --expires <when>               kill the link later: 30m, 12h, 7d, 2w, or a date
    --replace                      delete what's already in the space first
    --no-push                      don't push to git
    --no-deploy                    don't deploy to Cloudflare

  dumpyard remove <path>           unpublish a folder or page
  dumpyard lock <path>             lock a path, or rotate its password
    --password <value>
    --expires <when>
  dumpyard unlock <path>           make it public again
  dumpyard expire <path> <when>    change a locked path's expiry, or "never"
  dumpyard prune                   remove everything whose link has expired
  dumpyard list                    every lock, with its password and expiry
  dumpyard password <path>         print one password, nothing else
  dumpyard status                  is it set up, where, what's published (no passwords)
  dumpyard build                   re-render markdown and regenerate indexes
  dumpyard deploy                  deploy to Cloudflare with wrangler
  dumpyard init --repo <path>      scaffold a content repo and remember it
    --url <https://...>            the site's public base URL
  dumpyard upgrade                 refresh the gate and llms.txt from this CLI
  dumpyard install-skill [--dir <path>]   copy the agent skill into ~/.claude/skills

Every command that changes the site commits, pushes and deploys, unless told
not to. Paths may be written /space/, space/ or space.

Passwords are kept in ~/.config/dumpyard/passwords.json (mode 0600, override the
directory with DUMPYARD_HOME) so they can be read back. They are never written
into the repo, so they are never deployed.

Expiry applies to locked paths only. An expired link returns 410 to everyone,
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

const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const slug = (s) =>
  basename(s, extname(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
// "/project-xyz/" | "project-xyz" | "/project-xyz/notes" -> "project-xyz[/notes]"
const rel = (p) => String(p ?? "").replace(/^\/+|\/+$/g, "");
// Any spelling of a path -> "/project-xyz/", the form locks are keyed by.
const lockPath = (p) => {
  if (!rel(p)) throw new Error("needs a path, e.g. /project-xyz/");
  return `/${rel(p)}/`;
};
const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const expiryNote = (lock) =>
  !lock?.expires ? "" : locks.isExpired(lock) ? "EXPIRED" : `expires ${when(lock.expires)}`;

async function main() {
  const parsed = parse();
  flags = parsed.values;
  [command, ...args] = parsed.positionals;
  if (flags.help || !command || command === "help") return void console.log(HELP);

  if (command === "install-skill") {
    const dir = resolve(flags.dir ?? join(homedir(), ".claude", "skills", "dumpyard"));
    mkdirSync(dir, { recursive: true });
    cpSync(join(PKG, "skills", "dumpyard", "SKILL.md"), join(dir, "SKILL.md"));
    return void console.log(`installed ${join(dir, "SKILL.md")}`);
  }

  if (command === "init") {
    const repo = resolve(flags.repo ?? process.cwd());
    // A repo containing the password store would commit, push and deploy it.
    if (store.wouldContainStore(repo)) {
      throw new Error(`refusing: ${repo} would contain the password store (${store.storePath()})`);
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
    const url = flags.url ?? (prev && resolve(prev.repo) === repo ? prev.url : undefined);
    console.log(`scaffolded ${repo}\nremembered in ${saveConfig({ repo, url: url ?? undefined })}`);
    if (!flags.url) console.log("next: `dumpyard deploy` publishes it and records its URL");
    return;
  }

  if (command === "upgrade") {
    const repo = resolve(flags.repo ?? loadConfig().repo);
    for (const [src, dest = src] of [...CODE, ...MACHINE]) place(repo, src, dest);
    for (const [src, dest = src] of ONCE) if (!existsSync(join(repo, dest))) place(repo, src, dest);
    // llms.txt used to be served publicly from public/; it now lives at the root.
    if (existsSync(join(repo, "public", "llms.txt"))) rmSync(join(repo, "public", "llms.txt"));
    await build(repo, { quiet: true });
    console.log(`refreshed the gate and llms.txt in ${repo}`);
    return ship(repo, loadConfig({ repo }).url, "upgrade dumpyard");
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
    const path = lockPath(args[0]);
    const pw = store.recall(repo, path);
    if (!pw) {
      const locked = path in (await locks.load(repo));
      throw new Error(locked ? `${path} is locked, but its password isn't stored on this machine` : `${path} is not locked`);
    }
    return void console.log(pw);
  }

  if (command === "build") return void (await build(repo));
  if (command === "deploy") {
    const ok = await deploy(repo, url, { echo: true });
    return ok ? 0 : 2;
  }

  if (command === "unlock") {
    const path = lockPath(args[0]);
    await locks.unlock(repo, path);
    await build(repo, { quiet: true });
    console.log(`unlocked ${path} — it is public once deployed`);
    return ship(repo, url, `unlock ${rel(path)}`);
  }

  if (command === "lock") {
    const path = lockPath(args[0]);
    if (flags.expires) locks.parseWhen(flags.expires); // validate before changing anything
    const password = await locks.lock(repo, path, flags.password, url);
    if (flags.expires) await locks.setExpiry(repo, path, flags.expires);
    await build(repo, { quiet: true });
    console.log(`locked ${path}`);
    console.log(`password: ${password}   (readable later with \`dumpyard password ${path}\`)`);
    const lock = (await locks.load(repo))[path];
    if (lock?.expires) console.log(`expires:  ${when(lock.expires)}`);
    return ship(repo, url, `lock ${rel(path)}`);
  }

  if (command === "expire") {
    if (!args[1]) throw new Error("expire needs a path and a time, e.g. `dumpyard expire /x/ 7d`");
    const path = lockPath(args[0]);
    const at = await locks.setExpiry(repo, path, args[1]);
    console.log(at === null ? `${path} no longer expires` : `${path} expires ${when(at)}`);
    return ship(repo, url, `expiry ${rel(path)}`);
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
    return unpublish(repo, url, targets.map(rel), "prune expired");
  }

  if (command === "remove") {
    const target = rel(lockPath(args[0]));
    return unpublish(repo, url, [target], flags.message ?? `remove ${target}`);
  }

  if (command === "publish") return publish(repo, url);
  throw new Error(`unknown command "${command}"\n\n${HELP}`);
}

async function publish(repo, url) {
  if (!args.length) throw new Error("publish needs at least one file or directory");
  const space = flags.space ?? slug(args[0]);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(space)) {
    throw new Error(`bad space name "${space}" — lowercase letters, digits and dashes only`);
  }
  const path = `/${space}/`;
  const wantsLock = Boolean(flags.password || flags["set-password"]);

  // Everything that can fail is checked before the repo is touched. A publish
  // that dies halfway must never leave unlocked content behind for the next
  // commit to ship.
  for (const src of args) if (!existsSync(src)) throw new Error(`no such file: ${src}`);
  if (flags.password !== undefined && flags.password.length < 12) {
    throw new Error("a hand-picked password must be at least 12 characters (or use --set-password)");
  }
  if (flags.expires) {
    locks.parseWhen(flags.expires);
    if (!wantsLock && !(path in (await locks.load(repo)))) {
      throw new Error(`--expires needs a locked folder — add --set-password (${path} is public)`);
    }
  }

  // A lone page published without --space is the folder's page, so the link
  // you get is /name/, not /name/name.
  const single = args.length === 1 && !statSync(args[0]).isDirectory();
  const asIndex = single && !flags.space && /\.(html|md)$/i.test(args[0]);

  const dest = join(repo, "public", space);
  const existed = existsSync(dest);
  pull(repo);

  // Lock first. If anything below fails, the worst case is locked content,
  // never public content.
  if (wantsLock) await locks.lock(repo, path, flags.password, url);
  if (flags.expires) await locks.setExpiry(repo, path, flags.expires);

  let placed;
  try {
    if (existed && flags.replace) {
      rmSync(dest, { recursive: true, force: true });
      console.log(`cleared ${path}`);
    } else if (existed) {
      console.log(`updating existing ${path} (files not in this publish are kept — --replace clears them)`);
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
      if (wantsLock) await locks.unlock(repo, path).catch(() => {});
    }
    throw err;
  }

  commit(repo, flags.message ?? `publish ${space}`);
  if (!flags["no-push"]) push(repo);
  const deployed = flags["no-deploy"] ? null : await deploy(repo, url, { echo: isPlaceholder(url) });
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
  return verdict(deployed, live);
}

// Delete one or more folders/pages, drop their locks and passwords, ship.
async function unpublish(repo, url, targets, message) {
  pull(repo);
  let changed = false;
  for (const t of targets) {
    const base = join(repo, "public", t);
    // A page may be the markdown source, the rendered html, or a whole folder.
    for (const f of [base, `${base}.md`, `${base}.html`].filter((f) => existsSync(f))) {
      rmSync(f, { recursive: true, force: true });
      console.log(`removed ${f.slice(join(repo, "public").length + 1)}`);
      changed = true;
    }
    // Also clears a lock left dangling after its content was deleted by hand.
    for (const p of await locks.unlockUnder(repo, `/${t}/`)) {
      console.log(`dropped lock ${p}`);
      changed = true;
    }
  }
  if (!changed) throw new Error(`nothing published at /${targets[0]}/`);
  await build(repo, { quiet: true });
  const code = await ship(repo, url, message);
  if (code === 0) for (const t of targets) console.log(`${url}/${t}/ is gone. It is still in git history.`);
  return code;
}

// Commit, push, deploy, and say plainly whether the change is live.
async function ship(repo, url, message) {
  commit(repo, message);
  if (!flags["no-push"]) push(repo);
  const deployed = flags["no-deploy"] ? null : await deploy(repo, url, { echo: isPlaceholder(url) });
  return verdict(deployed, loadConfig({ repo }).url);
}

// null = deploy skipped on purpose, true = live, false = tried and failed.
function verdict(deployed, url) {
  if (deployed === true) {
    console.log("\nDeployed. Live now.");
    return 0;
  }
  if (deployed === null) {
    console.log("\nNot deployed (--no-deploy). None of this is live until you run `dumpyard deploy`.");
    if (isPlaceholder(url)) console.log("The URL above is a placeholder; the first deploy prints the real one.");
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
  console.log(`repo:      ${repo}`);
  console.log(`site:      ${isPlaceholder(url) ? "not deployed yet — run `dumpyard deploy`" : url}`);
  console.log(`spaces:    ${spaces.length ? spaces.map((s) => `/${s}/`).join(" ") : "none"}`);
  console.log(`locks:     ${lockPaths.length}${expired.length ? ` (${expired.length} expired — \`dumpyard prune\`)` : ""}`);
  console.log(`passwords: ${stored.length} of ${lockPaths.length} stored in ${store.storePath()}`);
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

// Streams wrangler's output when asked (always on the first deploy, which may
// need your input), and learns the workers.dev URL from it.
function deploy(repo, url, { echo }) {
  if (!existsSync(join(repo, "wrangler.jsonc"))) return Promise.resolve(false);
  return new Promise((done) => {
    let out = "";
    const child = spawn("npx", ["--yes", WRANGLER, "deploy"], { cwd: repo, stdio: ["inherit", "pipe", "pipe"] });
    const tap = (stream) => (d) => {
      out += d;
      if (echo) stream.write(d);
    };
    child.stdout.on("data", tap(process.stdout));
    child.stderr.on("data", tap(process.stderr));
    child.on("error", (err) => {
      console.error(`\nerror: could not run wrangler — ${err.message}`);
      done(false);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        if (!echo) process.stderr.write(out.trim().split("\n").slice(-6).join("\n") + "\n");
        const hint = /not logged in|authenticat|credential|API token|OAuth/i.test(out)
          ? `run \`npx ${WRANGLER} login\` once, then \`dumpyard deploy\``
          : /subdomain/i.test(out)
            ? `your Cloudflare account has no workers.dev subdomain yet — run \`npx ${WRANGLER} deploy\` once inside ${repo} and pick one, then \`dumpyard deploy\``
            : null;
        if (hint) console.error(`\n${hint}`);
        return done(false);
      }
      // Only replace a workers.dev (or placeholder) URL — never a custom
      // domain you set on purpose, or every deploy would quietly revert it.
      const live = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0];
      if (live && live !== url && (isPlaceholder(url) || /\.workers\.dev$/.test(url))) {
        saveConfig({ repo, url: live });
        console.log(`\nsite URL recorded: ${live}`);
      }
      done(true);
    });
  });
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
    console.warn(`warn: push failed — ${err.message.split("\n")[0]}`);
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
