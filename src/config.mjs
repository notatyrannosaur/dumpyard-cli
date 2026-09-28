// Where the content repo lives. Env wins, then ~/.config/dumpyard/config.json,
// written by `dumpyard init`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Printed links use this until the first deploy reports the real URL. Anything
// showing it has not been deployed, and the CLI says so.
export const PLACEHOLDER = "https://example.workers.dev";
export const isPlaceholder = (url) => !url || url === PLACEHOLDER;

// Same DUMPYARD_HOME override as the password store. One home = one site;
// use DUMPYARD_HOME or --repo to work with several.
const home = () => process.env.DUMPYARD_HOME ?? join(homedir(), ".config", "dumpyard");
const FILE = () => join(home(), "config.json");

export function loadConfig(overrides = {}) {
  const stored = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : {};
  const config = {
    url: PLACEHOLDER,
    ...stored,
    ...(process.env.DUMPYARD_REPO ? { repo: process.env.DUMPYARD_REPO } : {}),
    ...(process.env.DUMPYARD_URL ? { url: process.env.DUMPYARD_URL } : {}),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
  if (!config.repo) {
    throw new Error("no content repo configured — run `dumpyard init --repo <path>` first");
  }
  if (!existsSync(join(config.repo, "worker", "locks.js"))) {
    throw new Error(`${config.repo} is not a dumpyard repo — run \`dumpyard init --repo ${config.repo}\``);
  }
  return config;
}

export function saveConfig(config) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(config, null, 2) + "\n");
  return FILE();
}
