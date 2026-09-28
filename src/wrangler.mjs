// Checks on a site's own wrangler.jsonc, run before every deploy.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// JSON with // and /* */ comments and trailing commas, as wrangler accepts.
export function parseJsonc(text) {
  let out = "";
  for (let i = 0, str = false; i < text.length; i++) {
    const c = text[i];
    if (str) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') str = false;
    } else if (c === '"') {
      str = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1 || text.length;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// The template has a test for this; your site's copy is checked here, before
// every deploy, because you are invited to edit it (e.g. for a custom domain).
export function wranglerProblem(repo) {
  let cfg;
  try {
    cfg = parseJsonc(readFileSync(join(repo, "wrangler.jsonc"), "utf8"));
  } catch (err) {
    return `wrangler.jsonc can't be read: ${err.message}`;
  }
  if (cfg.assets?.run_worker_first !== true) {
    return 'wrangler.jsonc must have "assets": { "run_worker_first": true }. Without it Cloudflare serves files before the password check, and every locked page is public.';
  }
  if (!/^(\.\/)?public\/?$/.test(cfg.assets?.directory ?? "")) {
    return 'wrangler.jsonc "assets.directory" must be "./public". Anything wider uploads worker/locks.js and the rest of the repo.';
  }
  if (!/^(\.\/)?worker\/index\.js$/.test(cfg.main ?? "")) return 'wrangler.jsonc "main" must be "worker/index.js", the password gate.';
  return null;
}

