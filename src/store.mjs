// Passwords the CLI has issued, kept so they can be read back.
//
// This tool publishes agent-made artifacts; nobody memorises a generated
// password, and an agent that cannot read one back cannot re-share the link.
// The trust boundary is the public internet, so plaintext on your own disk is
// deliberate — but it lives in ~/.config, mode 0600, and NEVER inside a content
// repo, because that would get committed, pushed and deployed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

// Resolved per call so DUMPYARD_HOME can redirect it (tests, separate profiles).
export const home = () => process.env.DUMPYARD_HOME ?? join(homedir(), ".config", "dumpyard");
export const storePath = () => join(home(), "passwords.json");

// True when `repo` contains the password store — an init that would publish it.
export function wouldContainStore(repo) {
  const rel = relative(resolve(repo), storePath());
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const read = () => (existsSync(storePath()) ? JSON.parse(readFileSync(storePath(), "utf8")) : {});

function write(all) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  chmodSync(storePath(), 0o600); // tighten it even if the file already existed
}

export function remember(repo, path, password, url) {
  const all = read();
  (all[resolve(repo)] ??= {})[path] = { password, url, created: new Date().toISOString() };
  write(all);
}

export function forget(repo, path) {
  const all = read();
  const site = all[resolve(repo)];
  if (!site || !(path in site)) return false;
  delete site[path];
  if (!Object.keys(site).length) delete all[resolve(repo)];
  write(all);
  return true;
}

// Drop every remembered password at or beneath `prefix`.
export function forgetUnder(repo, prefix) {
  const all = read();
  const site = all[resolve(repo)] ?? {};
  const gone = Object.keys(site).filter((p) => p === prefix || p.startsWith(prefix));
  for (const p of gone) delete site[p];
  if (!Object.keys(site).length) delete all[resolve(repo)];
  write(all);
  return gone;
}

export const recall = (repo, path) => read()[resolve(repo)]?.[path]?.password ?? null;
export const forRepo = (repo) => read()[resolve(repo)] ?? {};
