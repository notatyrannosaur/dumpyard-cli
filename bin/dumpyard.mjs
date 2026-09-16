#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "../src/config.mjs";
import { build } from "../src/build.mjs";
import * as locks from "../src/locks.mjs";

const TEMPLATES = fileURLToPath(new URL("../templates", import.meta.url));

const HELP = `dumpyard — publish pages, notes, PDFs and images, each path behind its own password

  dumpyard publish <file|dir>...   add content and push
    --space <name>                 folder to publish into (default: the file's name)
    --set-password                 lock the space with a generated password
    --password <value>             lock it with your own (12+ characters)
    --no-push                      stage locally, don't push

  dumpyard lock <path>             lock an existing path, e.g. /project-xyz/
    --password <value>
  dumpyard unlock <path>           make it public again
  dumpyard list                    what is locked
  dumpyard build                   re-render markdown and regenerate indexes
  dumpyard init --repo <path>      scaffold a content repo and remember it
    --url <https://...>            the site's public base URL
  dumpyard upgrade                 refresh the gate and llms.txt from this CLI
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    space: { type: "string" },
    password: { type: "string" },
    "set-password": { type: "boolean" },
    "no-push": { type: "boolean" },
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
    mkdirSync(repo, { recursive: true });
    for (const entry of readdirSync(TEMPLATES)) {
      const dest = join(repo, entry);
      if (entry === "functions" || !existsSync(dest)) {
        cpSync(join(TEMPLATES, entry), dest, { recursive: true, force: entry === "functions" });
      }
    }
    if (!existsSync(join(repo, ".git"))) {
      execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
      console.log("initialised a git repo");
    }
    await build(repo, { quiet: true });
    const url = flags.url ?? "https://example.pages.dev";
    const file = saveConfig({ repo, url });
    console.log(`scaffolded ${repo}\nremembered in ${file}`);
    if (!flags.url) console.log("set the real site URL later with: dumpyard init --repo <path> --url https://...");
    return;
  }

  if (command === "upgrade") {
    const repo = resolve(flags.repo ?? loadConfig().repo);
    // Machine-owned files only. README.md and your content are never touched,
    // and locks.js is left alone because it holds real hashes.
    cpSync(join(TEMPLATES, "functions", "_middleware.js"), join(repo, "functions", "_middleware.js"));
    cpSync(join(TEMPLATES, "functions", "hash.js"), join(repo, "functions", "hash.js"));
    for (const f of ["llms.txt", "robots.txt", "404.html"]) {
      cpSync(join(TEMPLATES, f), join(repo, f));
    }
    await build(repo, { quiet: true });
    return console.log(`refreshed the gate and llms.txt in ${repo}`);
  }

  const config = loadConfig({ repo: flags.repo, url: flags.url });
  const { repo, url } = config;

  if (command === "list") {
    const table = await locks.load(repo);
    const paths = Object.keys(table).sort();
    return console.log(paths.length ? paths.join("\n") : "nothing is locked");
  }

  if (command === "build") return void (await build(repo));

  if (command === "unlock") {
    await locks.unlock(repo, args[0]);
    await build(repo, { quiet: true });
    return console.log(`unlocked ${args[0]} — public on the next deploy`);
  }

  if (command === "lock") {
    const password = await locks.lock(repo, args[0], flags.password);
    await build(repo, { quiet: true });
    console.log(`locked ${args[0]}`);
    console.log(`password: ${password}`);
    return console.log("Shown once. Commit and push to apply it.");
  }

  if (command !== "publish") throw new Error(`unknown command "${command}"\n\n${HELP}`);
  if (!args.length) throw new Error("publish needs at least one file or directory");

  const space = flags.space ?? slug(args[0]);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(space)) {
    throw new Error(`bad space name "${space}" — lowercase letters, digits and dashes only`);
  }
  const dest = join(repo, space);
  mkdirSync(dest, { recursive: true });

  pull(repo);
  for (const src of args) {
    if (!existsSync(src)) throw new Error(`no such file: ${src}`);
    const target = statSync(src).isDirectory() ? dest : join(dest, basename(src));
    cpSync(src, target, { recursive: true });
    console.log(`added ${space}/${statSync(src).isDirectory() ? "" : basename(src)}`);
  }

  let password;
  if (flags.password || flags["set-password"]) {
    password = await locks.lock(repo, `/${space}/`, flags.password);
    // Print it now. A generated password exists nowhere else, so it must not be
    // lost to a build or git failure further down.
    console.log(`\nlocked /${space}/`);
    console.log(`password: ${password}`);
    console.log("Shown once — it is stored nowhere and cannot be recovered.\n");
  }
  await build(repo);

  git(repo, "add", "-A");
  const message = flags.message ?? `publish ${space}`;
  try {
    git(repo, "commit", "-m", message);
  } catch {
    console.log("nothing new to commit");
  }
  const pushed = !flags["no-push"] && push(repo);

  console.log(`\n${url}/${space}/`);
  if (password) {
    console.log(`password: ${password}   (any username works at the prompt)`);
    console.log("Locked areas are left off the public index, so send the link directly.");
  }
  if (pushed) console.log("\nPushed. Cloudflare redeploys in about 30 seconds.");
  else if (!flags["no-push"]) console.log("\nNot pushed — no git remote configured.");
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
