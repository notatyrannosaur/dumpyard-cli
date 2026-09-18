// Where the content repo lives. Env wins, then ~/.config/dumpyard/config.json,
// written by `dumpyard init`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE = join(homedir(), ".config", "dumpyard", "config.json");

export function loadConfig(overrides = {}) {
  const stored = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  const config = {
    url: "https://example.pages.dev",
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
  mkdirSync(join(homedir(), ".config", "dumpyard"), { recursive: true });
  writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n");
  return FILE;
}
