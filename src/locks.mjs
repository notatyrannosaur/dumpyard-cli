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
  locks[path] = { salt, hash: await digest(salt, password) };
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
