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
    --no-push                      don't push to git
    --no-deploy                    don't deploy to Cloudflare

  dumpyard remove <path>           unpublish a folder or page, and deploy
  dumpyard lock <path>             lock an existing path, e.g. /project-xyz/
    --password <value>
  dumpyard unlock <path>           make it public again
  dumpyard list                    every lock, with its password
  dumpyard password <path>         print one password, nothing else
  dumpyard build                   re-render markdown and regenerate indexes
  dumpyard deploy                  deploy to Cloudflare with wrangler
  dumpyard init --repo <path>      scaffold a content repo and remember it
    --url <https://...>            the site's public base URL
  dumpyard upgrade                 refresh the gate and llms.txt from this CLI

Passwords are kept in ~/.config/dumpyard/passwords.json (mode 0600, override the
directory with DUMPYARD_HOME) so they can
be read back. They are never written into the repo, so they are never deployed.
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    space: { type: "string" },
    password: { type: "string" },
    "set-password": { type: "boolean" },
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
      const pw = store.recall(repo, p);
      console.log(`${p.padEnd(width)}  ${pw ?? "(password not stored on this machine)"}`);
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
    const password = await locks.lock(repo, args[0], flags.password, url);
    await build(repo, { quiet: true });
    console.log(`locked ${args[0]}`);
    console.log(`password: ${password}`);
    return console.log("Deploy to apply it. Readable later with `dumpyard password`.");
  }

  if (command === "remove") return void (await remove(repo, url));
  if (command !== "publish") throw new Error(`unknown command "${command}"\n\n${HELP}`);
  return void (await publish(repo, url));
}

async function publish(repo, url) {
  if (!args.length) throw new Error("publish needs at least one file or directory");
  const space = flags.space ?? slug(args[0]);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(space)) {
    throw new Error(`bad space name "${space}" — lowercase letters, digits and dashes only`);
  }
  const dest = join(repo, "public", space);
  mkdirSync(dest, { recursive: true });

  pull(repo);
  for (const src of args) {
    if (!existsSync(src)) throw new Error(`no such file: ${src}`);
    const isDir = statSync(src).isDirectory();
    cpSync(src, isDir ? dest : join(dest, basename(src)), { recursive: true });
    console.log(`added ${space}/${isDir ? "" : basename(src)}`);
  }

  if (flags.password || flags["set-password"]) {
    await locks.lock(repo, `/${space}/`, flags.password, url);
  }
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
  const password = store.recall(repo, `/${space}/`);
  console.log(`\n${url}/${space}/`);
  if (password) {
    console.log(`password: ${password}   (any username works at the prompt)`);
    console.log("Locked areas are left off the public index, so send the link directly.");
  }
  if (deployed) console.log("\nDeployed. Live now.");
  else if (pushed) console.log("\nPushed. Cloudflare rebuilds if Git builds are connected.");
}

async function remove(repo, url) {
  const target = rel(args[0]);
  if (!target) throw new Error("remove needs a path, e.g. /project-xyz/");
  const base = join(repo, "public", target);
  // A page may be the markdown source, the rendered html, or a whole folder.
  const hits = [base, `${base}.md`, `${base}.html`].filter((f) => existsSync(f));
  if (!hits.length) throw new Error(`nothing published at /${target}/`);

  pull(repo);
  for (const f of hits) {
    rmSync(f, { recursive: true, force: true });
    console.log(`removed ${f.slice(join(repo, "public").length + 1)}`);
  }
  const dropped = await locks.unlockUnder(repo, `/${target}/`);
  for (const p of dropped) console.log(`dropped lock ${p}`);
  await build(repo);

  git(repo, "add", "-A");
  try {
    git(repo, "commit", "-m", flags.message ?? `remove ${target}`);
  } catch {
    console.log("nothing to commit");
  }
  if (!flags["no-push"]) push(repo);
  const deployed = !flags["no-deploy"] && deploy(repo, { loud: false, url });
  console.log(
    deployed
      ? `\n${url}/${target}/ is gone. Still in git history if you need it back.`
      : `\nRemoved locally. Run \`dumpyard deploy\` to take it off the site.`,
  );
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
    const out = execFileSync("npx", ["--yes", "wrangler@latest", "deploy"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    if (loud) process.stdout.write(out);
    // You cannot know the workers.dev URL until the first deploy, so learn it
    // here rather than making the user run init a second time.
    const live = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0];
    if (live && live !== url) {
      saveConfig({ repo, url: live });
      console.log(`\nsite URL recorded: ${live}`);
    }
    return true;
  } catch (err) {
    const text = String(err.stderr ?? err.message);
    const hint = /not logged in|authenticat|credential|API token|OAuth/i.test(text)
      ? "run `npx wrangler login` once, then `dumpyard deploy`"
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
