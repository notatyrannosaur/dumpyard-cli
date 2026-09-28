// Local secrets: the passwords the CLI has issued, and each site's pepper.
//
// This tool publishes agent-made artifacts. Nobody memorises a generated
// password, and an agent that can't read one back can't re-share the link, so
// passwords are kept. The trust boundary is the public internet, so plaintext on
// your own disk is deliberate — but it lives in ~/.config, mode 0600, and NEVER
// inside a content repo, because that would be committed, pushed and deployed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

// Resolved per call so DUMPYARD_HOME can redirect it (tests, separate sites).
export const home = () => process.env.DUMPYARD_HOME ?? join(homedir(), ".config", "dumpyard");
export const storePath = () => join(home(), "passwords.json");
const pepperFile = () => join(home(), "peppers.json");

// True when `repo` contains the store — an init that would publish it.
export function wouldContainStore(repo) {
  const rel = relative(resolve(repo), home());
  return !rel.startsWith("..") && !isAbsolute(rel);
}

const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
function write(file, data) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600); // tighten it even if the file already existed
}

export function remember(repo, path, password, url) {
  const all = read(storePath());
  (all[resolve(repo)] ??= {})[path] = { password, url, created: new Date().toISOString() };
  write(storePath(), all);
}

export function forget(repo, path) {
  const all = read(storePath());
  const site = all[resolve(repo)];
  if (!site || !(path in site)) return false;
  delete site[path];
  if (!Object.keys(site).length) delete all[resolve(repo)];
  write(storePath(), all);
  return true;
}

// Drop every remembered password at or beneath `prefix`.
export function forgetUnder(repo, prefix) {
  const all = read(storePath());
  const site = all[resolve(repo)] ?? {};
  const gone = Object.keys(site).filter((p) => p === prefix || p.startsWith(prefix));
  for (const p of gone) delete site[p];
  if (!Object.keys(site).length) delete all[resolve(repo)];
  write(storePath(), all);
  return gone;
}

export const recall = (repo, path) => read(storePath())[resolve(repo)]?.[path]?.password ?? null;
export const forRepo = (repo) => read(storePath())[resolve(repo)] ?? {};

// The site's pepper: { value, uploaded } or null. Losing it invalidates every
// password on the site, so it is created once and never replaced silently.
export const pepper = (repo) => read(pepperFile())[resolve(repo)] ?? null;

export function createPepper(repo) {
  const all = read(pepperFile());
  if (all[resolve(repo)]) throw new Error("this site already has a pepper");
  all[resolve(repo)] = { value: randomBytes(32).toString("hex"), uploaded: false };
  write(pepperFile(), all);
  return all[resolve(repo)];
}

export function markPepperUploaded(repo, uploaded = true) {
  const all = read(pepperFile());
  if (!all[resolve(repo)]) return;
  all[resolve(repo)].uploaded = uploaded;
  write(pepperFile(), all);
}

// Sites whose repo folder no longer exists but still have secrets stored.
export function orphans() {
  const repos = new Set([...Object.keys(read(storePath())), ...Object.keys(read(pepperFile()))]);
  return [...repos].filter((r) => !existsSync(join(r, "worker", "locks.js")));
}
