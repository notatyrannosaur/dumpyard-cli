#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "../src/config.mjs";
import { build } from "../src/build.mjs";
import * as locks from "../src/locks.mjs";
import * as store from "../src/store.mjs";

const TEMPLATES = fileURLToPath(new URL("../templates", import.meta.url));

// Pinned: @latest would let a Cloudflare release break publishing overnight
// with no change on our side. Bump deliberately, after running the tests.
const WRANGLER = "wrangler@4.134.0";

// Worker code: always refreshed, it is ours.
const CODE = ["worker/index.js", "worker/hash.js"];
// Machine-facing text: refreshed by `upgrade`, seeded by `init`.
const MACHINE = ["public/llms.txt", "public/robots.txt", "public/404.html"];
// Yours once created. locks.js holds real hashes; wrangler.jsonc and README get
// edited by hand. Never clobbered.
const ONCE = ["worker/locks.js", "wrangler.jsonc", "README.md"];

const HELP = `dumpyard — publish pages, notes, PDFs and images, each path behind its own password

  dumpyard publish <file|dir>...   add content, commit, push and deploy
    --space <name>                 folder to publish into (default: the file's name)
    --set-password                 lock the space with a generated password
    --password <value>             lock it with your own (12+ characters)
    --expires <when>               kill the link later: 30m, 12h, 7d, 2w, or a date
    --no-push                      don't push to git
    --no-deploy                    don't deploy to Cloudflare

  dumpyard remove <path>           unpublish a folder or page, and deploy
  dumpyard lock <path>             lock an existing path, e.g. /project-xyz/
    --password <value>
    --expires <when>
  dumpyard unlock <path>           make it public again
  dumpyard expire <path> <when>    change a locked path's expiry, or "never"
  dumpyard prune                   remove everything whose link has expired
  dumpyard list                    every lock, with its password and expiry
  dumpyard password <path>         print one password, nothing else
  dumpyard build                   re-render markdown and regenerate indexes
  dumpyard deploy                  deploy to Cloudflare with wrangler
  dumpyard init --repo <path>      scaffold a content repo and remember it
    --url <https://...>            the site's public base URL
  dumpyard upgrade                 refresh the gate and llms.txt from this CLI

Passwords are kept in ~/.config/dumpyard/passwords.json (mode 0600, override the
directory with DUMPYARD_HOME) so they can be read back. They are never written
into the repo, so they are never deployed.

Expiry applies to locked paths only. An expired link returns 410 to everyone,
even with the right password; \`prune\` then removes the content itself.
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    space: { type: "string" },
    password: { type: "string" },
    "set-password": { type: "boolean" },
    expires: { type: "string" },
    "no-push": { type: "boolean" },
    "no-deploy": { type: "boolean" },
    repo: { type: "string" },
    url: { type: "string" },
    message: { type: "string", short: "m" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...args] = positionals;
const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const slug = (s) =>
  basename(s, extname(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
// "/project-xyz/" | "project-xyz" | "/project-xyz/notes" -> "project-xyz[/notes]"
const rel = (p) => String(p ?? "").replace(/^\/+|\/+$/g, "");
const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const expiryNote = (lock) =>
  !lock?.expires ? "" : locks.isExpired(lock) ? "EXPIRED" : `expires ${when(lock.expires)}`;

try {
  await main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}

async function main() {
  if (flags.help || !command || command === "help") return console.log(HELP);

  if (command === "init") {
    const repo = resolve(flags.repo ?? process.cwd());
    // A repo containing the password store would commit, push and deploy it.
    if (store.wouldContainStore(repo)) {
      throw new Error(`refusing: ${repo} would contain the password store (${store.storePath()})`);
    }
    mkdirSync(repo, { recursive: true });
    for (const r of [...CODE, ...MACHINE, ...ONCE]) {
      if (CODE.includes(r) || !existsSync(join(repo, r))) place(repo, r);
    }
    nameProject(repo);
    if (!existsSync(join(repo, ".git"))) {
      execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
      console.log("initialised a git repo");
    }
    await build(repo, { quiet: true });
    const url = flags.url ?? "https://example.workers.dev";
    console.log(`scaffolded ${repo}\nremembered in ${saveConfig({ repo, url })}`);
    if (!flags.url) console.log("run `dumpyard deploy` to publish it and learn its URL");
    return;
  }

  if (command === "upgrade") {
    const repo = resolve(flags.repo ?? loadConfig().repo);
    for (const r of [...CODE, ...MACHINE]) place(repo, r);
    await build(repo, { quiet: true });
    return console.log(`refreshed the gate and llms.txt in ${repo}`);
  }

  const { repo, url } = loadConfig({ repo: flags.repo, url: flags.url });

  if (command === "list") {
    const table = await locks.load(repo);
    const paths = Object.keys(table).sort();
    if (!paths.length) return console.log("nothing is locked");
    const width = Math.max(...paths.map((p) => p.length));
    for (const p of paths) {
      const pw = store.recall(repo, p) ?? "(password not stored on this machine)";
      console.log(`${p.padEnd(width)}  ${pw}  ${expiryNote(table[p])}`.trimEnd());
    }
    return;
  }

  if (command === "password") {
    const path = locks.checkPath(args[0]);
    const pw = store.recall(repo, path);
    if (!pw) throw new Error(`no stored password for ${path}`);
    return console.log(pw);
  }

  if (command === "build") return void (await build(repo));
  if (command === "deploy") return void deploy(repo, { loud: true, url });

  if (command === "unlock") {
    await locks.unlock(repo, args[0]);
    await build(repo, { quiet: true });
    return console.log(`unlocked ${args[0]} — public on the next deploy`);
  }

  if (command === "lock") {
    const expires = flags.expires && locks.parseWhen(flags.expires); // validate first
    const password = await locks.lock(repo, args[0], flags.password, url);
    if (flags.expires) await locks.setExpiry(repo, args[0], flags.expires);
    await build(repo, { quiet: true });
    console.log(`locked ${args[0]}`);
    console.log(`password: ${password}`);
    if (expires) console.log(`expires:  ${when(expires)}`);
    return console.log("Deploy to apply it. Readable later with `dumpyard password`.");
  }

  if (command === "expire") {
    if (!args[1]) throw new Error("expire needs a path and a time, e.g. `dumpyard expire /x/ 7d`");
    const at = await locks.setExpiry(repo, args[0], args[1]);
    console.log(at === null ? `${args[0]} no longer expires` : `${args[0]} expires ${when(at)}`);
    // No rebuild needed — expiry is enforced by the Worker, which reads locks.js.
    return shipOrSay(repo, url, `expiry ${rel(args[0])}`);
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
    if (!targets.length) return console.log("nothing has expired");
    return unpublish(repo, url, targets.map(rel), "prune expired");
  }

  if (command === "remove") {
    if (!rel(args[0])) throw new Error("remove needs a path, e.g. /project-xyz/");
    return unpublish(repo, url, [rel(args[0])], flags.message ?? `remove ${rel(args[0])}`);
  }

  if (command !== "publish") throw new Error(`unknown command "${command}"\n\n${HELP}`);
  return void (await publish(repo, url));
}

async function publish(repo, url) {
  if (!args.length) throw new Error("publish needs at least one file or directory");
  const space = flags.space ?? slug(args[0]);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(space)) {
    throw new Error(`bad space name "${space}" — lowercase letters, digits and dashes only`);
  }
  const path = `/${space}/`;
  const wantsLock = Boolean(flags.password || flags["set-password"]);

  // Check everything that can fail before touching the repo.
  for (const src of args) if (!existsSync(src)) throw new Error(`no such file: ${src}`);
  if (flags.expires) {
    locks.parseWhen(flags.expires);
    if (!wantsLock && !(path in (await locks.load(repo)))) {
      throw new Error(`--expires needs a locked folder — add --set-password (${path} is public)`);
    }
  }

  const dest = join(repo, "public", space);
  if (existsSync(dest)) console.log(`updating existing ${path}`);
  mkdirSync(dest, { recursive: true });

  pull(repo);
  for (const src of args) {
    const isDir = statSync(src).isDirectory();
    cpSync(src, isDir ? dest : join(dest, basename(src)), { recursive: true });
    console.log(`added ${space}/${isDir ? "" : basename(src)}`);
  }

  if (wantsLock) await locks.lock(repo, path, flags.password, url);
  if (flags.expires) await locks.setExpiry(repo, path, flags.expires);
  await build(repo);

  git(repo, "add", "-A");
  try {
    git(repo, "commit", "-m", flags.message ?? `publish ${space}`);
  } catch {
    console.log("nothing new to commit");
  }
  const pushed = !flags["no-push"] && push(repo);
  const deployed = !flags["no-deploy"] && deploy(repo, { loud: false, url });

  // Show the password whether it was just set or set on an earlier publish —
  // re-sharing a link shouldn't mean re-locking it.
  const password = store.recall(repo, path);
  const lock = (await locks.load(repo))[path];
  console.log(`\n${url}${path}`);
  if (password) console.log(`password: ${password}   (any username works at the prompt)`);
  if (lock?.expires) console.log(`expires:  ${when(lock.expires)}`);
  if (password) console.log("Locked areas are left off the public index, so send the link directly.");
  if (deployed) console.log("\nDeployed. Live now.");
  else if (pushed) console.log("\nPushed. Cloudflare rebuilds if Git builds are connected.");
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
  await build(repo);
  await shipOrSay(repo, url, message, targets);
}

async function shipOrSay(repo, url, message, removed = []) {
  git(repo, "add", "-A");
  try {
    git(repo, "commit", "-m", message);
  } catch {
    console.log("nothing to commit");
  }
  if (!flags["no-push"]) push(repo);
  const deployed = !flags["no-deploy"] && deploy(repo, { loud: false, url });
  if (!deployed) return console.log("\nNot deployed. Run `dumpyard deploy` to apply it.");
  for (const t of removed) console.log(`${url}/${t}/ is gone. Still in git history if you need it back.`);
  if (!removed.length) console.log("\nDeployed. Live now.");
}

// Copy one template file into the repo, creating its folder.
function place(repo, r) {
  const dest = join(repo, r);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(join(TEMPLATES, r), dest);
}

// The Worker's name comes from the folder, so two sites don't collide.
function nameProject(repo) {
  const file = join(repo, "wrangler.jsonc");
  const name = basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  writeFileSync(file, readFileSync(file, "utf8").replace(/"name":\s*"[^"]*"/, `"name": "${name}"`));
}

function deploy(repo, { loud, url }) {
  if (!existsSync(join(repo, "wrangler.jsonc"))) return false;
  try {
    const out = execFileSync("npx", ["--yes", WRANGLER, "deploy"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    if (loud) process.stdout.write(out);
    // You cannot know the workers.dev URL until the first deploy, so learn it
    // here. Only replace a workers.dev (or placeholder) URL — never a custom
    // domain you set on purpose, or every deploy would quietly revert it.
    const live = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0];
    if (live && live !== url && /\.workers\.dev$/.test(url ?? "")) {
      saveConfig({ repo, url: live });
      console.log(`\nsite URL recorded: ${live}`);
    }
    return true;
  } catch (err) {
    const text = String(err.stderr ?? err.message);
    const hint = /not logged in|authenticat|credential|API token|OAuth/i.test(text)
      ? `run \`npx ${WRANGLER} login\` once, then \`dumpyard deploy\``
      : text.trim().split("\n").slice(-3).join("\n") || err.message;
    console.warn(`\nwarn: not deployed — ${hint}`);
    return false;
  }
}

function pull(repo) {
  try {
    if (git(repo, "remote")) git(repo, "pull", "--ff-only");
  } catch {
    console.warn("warn: could not pull; continuing with the local copy");
  }
}

function push(repo) {
  try {
    if (!git(repo, "remote")) return false;
    git(repo, "push");
    return true;
  } catch (err) {
    console.warn(`warn: push failed — ${err.message.split("\n")[0]}`);
    return false;
  }
}
