// Read/write <repo>/functions/locks.js. The salted hashes live in the content
// repo; the passwords are never stored anywhere.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { digest } from "../templates/worker/hash.js";
import * as store from "./store.mjs";

export const locksPath = (repo) => join(repo, "worker", "locks.js");

export async function load(repo) {
  const url = pathToFileURL(locksPath(repo)).href;
  return (await import(`${url}?v=${Date.now()}`)).default;
}

export function save(repo, locks) {
  const file = locksPath(repo);
  const header = readFileSync(file, "utf8").split("export default")[0];
  const body = Object.keys(locks)
    .sort()
    .map((p) => `  ${JSON.stringify(p)}: ${JSON.stringify(locks[p])},`)
    .join("\n");
  writeFileSync(file, `${header}export default {\n${body}${body ? "\n" : ""}};\n`);
}

export function checkPath(path) {
  if (!path?.startsWith("/") || !path.endsWith("/")) {
    throw new Error(`path must start and end with "/" — e.g. /project-xyz/, not ${path}`);
  }
  return path;
}

// Returns the password, and remembers it so it can be read back later.
export async function lock(repo, path, chosen, url) {
  checkPath(path);
  // A short hand-picked password is crackable offline against the hash in the
  // repo; a generated one carries 72 bits and is not.
  if (chosen !== undefined && chosen.length < 12) {
    throw new Error("a hand-picked password must be at least 12 characters");
  }
  const password = chosen ?? randomBytes(9).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const locks = await load(repo);
  // Rotating a password must not quietly extend a link's life, so any expiry
  // already on this path survives the re-lock.
  const expires = locks[path]?.expires;
  locks[path] = { salt, hash: await digest(salt, password), ...(expires ? { expires } : {}) };
  save(repo, locks);
  store.remember(repo, path, password, url);
  return password;
}

export async function unlock(repo, path) {
  checkPath(path);
  const locks = await load(repo);
  if (!(path in locks)) throw new Error(`${path} is not locked`);
  delete locks[path];
  save(repo, locks);
  store.forget(repo, path);
}

// Drop every lock at or beneath `prefix`. Used when removing a folder, so a
// deleted space can't leave an orphan lock behind.
export async function unlockUnder(repo, prefix) {
  const locks = await load(repo);
  const gone = Object.keys(locks).filter((p) => p === prefix || p.startsWith(prefix));
  for (const p of gone) delete locks[p];
  if (gone.length) save(repo, locks);
  store.forgetUnder(repo, prefix);
  return gone;
}

// "30m" | "12h" | "7d" | "2w" | an ISO date ("2026-10-01", UTC) -> epoch ms.
// "never" -> null, which clears an expiry.
export function parseWhen(when, now = Date.now()) {
  if (when === "never") return null;
  const rel = /^(\d+)\s*([mhdw])$/.exec(String(when).trim());
  if (rel) {
    const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[rel[2]];
    return now + Number(rel[1]) * unit;
  }
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(when) ? `${when}T00:00:00Z` : when);
  if (Number.isNaN(at)) {
    throw new Error(`can't read "${when}" as an expiry — use 30m, 12h, 7d, 2w, a date, or never`);
  }
  if (at <= now) throw new Error(`"${when}" is already in the past`);
  return at;
}

// Set or clear expiry on an existing lock without touching its password.
export async function setExpiry(repo, path, when) {
  checkPath(path);
  const locks = await load(repo);
  if (!(path in locks)) {
    throw new Error(`${path} is not locked — expiry only applies to locked folders (add --set-password)`);
  }
  const at = parseWhen(when);
  if (at === null) delete locks[path].expires;
  else locks[path].expires = at;
  save(repo, locks);
  return at;
}

export const isExpired = (lock, now = Date.now()) => Boolean(lock?.expires && now >= lock.expires);
