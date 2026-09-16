// Walk the content repo, render markdown, regenerate every index.
//
// Conventions, so a rebuild never mistakes its own output for a source:
//   foo.md          -> foo.html          (foo.html is generated, never a source)
//   index.html      -> always generated; write index.md to control a folder's page
//   anything else   -> served as-is (PDFs, images, hand-written .html)
//
// A listing shows an entry only if that entry is no more secret than the page
// listing it, so a public index never leaks the name of a locked page.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";
import { render, titleOf } from "./markdown.mjs";
import { load as loadLocks } from "./locks.mjs";
import { lockFor } from "../templates/functions/hash.js";

const SKIP_DIRS = new Set(["functions", "node_modules", ".git", ".github", ".wrangler"]);
const ROOT_FILES = new Set(["index.html", "404.html", "robots.txt", "llms.txt", "README.md"]);
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const STYLE = `
  html { color-scheme: light dark;
         background: light-dark(#fff, #111); color: light-dark(#111, #ddd); }
  body { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem;
         font: 1rem/1.65 Georgia, 'Times New Roman', serif; overflow-wrap: break-word; }
  h1 { font-size: 1.5rem; font-weight: normal; margin: 0 0 .25rem; }
  h2, h3, h4 { font-weight: normal; margin: 2rem 0 .5rem; }
  hr { border: 0; border-top: 1px solid currentColor; opacity: .4; margin: 1.5rem 0; }
  a { color: inherit; }
  .meta { font-style: italic; opacity: .8; }
  .type { opacity: .55; font-style: italic; font-size: .85em; }
  .broken { color: light-dark(#a00, #f77); border-bottom: 1px dotted currentColor; }
  ul { padding-left: 1.25rem; }
  li { margin: .15rem 0; }
  img { max-width: 100%; height: auto; }
  pre { background: light-dark(#f4f4f4, #1c1c1c); padding: .75rem 1rem;
        overflow-x: auto; font-size: .9rem; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
  pre code { font-size: inherit; }
  blockquote { margin: 1rem 0; padding-left: 1rem;
               border-left: 3px solid currentColor; opacity: .85; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid light-dark(#ccc, #444); padding: .35rem .6rem; text-align: left; }
  footer { margin-top: 3rem; font-size: .875rem; opacity: .7; }`;

const shell = ({ title, body, up }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}
</style>
</head>
<body>
${up ? `<p class="meta"><a href="${esc(up)}">&larr; up</a></p>\n` : ""}${body}
<footer>Built by dumpyard.</footer>
</body>
</html>
`;

function walk(dir, repo, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    const rel = relative(repo, full);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(rel)) continue;
      walk(full, repo, out);
    } else if (!(dirname(rel) === "." && ROOT_FILES.has(e.name))) {
      out.push(rel);
    }
  }
  return out;
}

// Cloudflare Pages serves foo.html at /foo and 308-redirects the .html form,
// so links point at the canonical extensionless URL and skip the round trip.
const urlOf = (rel) => {
  const p = "/" + rel.split(/[\\/]/).join("/");
  return p.replace(/\/index\.(md|html?)$/i, "/").replace(/\.(md|html?)$/i, "");
};
const kindOf = (rel) =>
  /\.md$/i.test(rel) || /\.html?$/i.test(rel)
    ? "page"
    : IMAGE.test(rel)
      ? "image"
      : /\.pdf$/i.test(rel)
        ? "pdf"
        : "file";

export async function build(repo, { quiet = false } = {}) {
  const locks = await loadLocks(repo);
  const all = walk(repo, repo);
  const mds = new Set(all.filter((r) => /\.md$/i.test(r)).map((r) => r.replace(/\.md$/i, "")));

  // Sources = everything that is not this build's own output.
  const sources = all.filter((rel) => {
    if (basename(rel).toLowerCase() === "index.html") return false;
    if (/\.html$/i.test(rel) && mds.has(rel.replace(/\.html$/i, ""))) return false;
    return true;
  });

  // Wikilink index: bare name, and "folder/name" to disambiguate duplicates.
  const index = new Map();
  const add = (key, value) => {
    const k = key.toLowerCase();
    if (!index.has(k)) index.set(k, value);
  };
  const titles = new Map();
  for (const rel of sources) {
    const url = urlOf(rel);
    const stem = basename(rel).replace(/\.(md|html?)$/i, "");
    const title = /\.md$/i.test(rel)
      ? titleOf(readFileSync(join(repo, rel), "utf8"), stem)
      : stem;
    titles.set(rel, title);
    const entry = { url, title };
    add(stem, entry);
    add(basename(rel), entry);
    add(`${dirname(rel).split(/[\\/]/).pop()}/${stem}`, entry);
    add(rel.replace(/\\/g, "/"), entry);
  }

  const broken = [];
  const bodies = new Map();
  let rendered = 0;
  for (const rel of sources.filter((r) => /\.md$/i.test(r))) {
    const text = readFileSync(join(repo, rel), "utf8");
    // A link may only resolve to a target no more secret than the page holding
    // it. Otherwise a public note would publish a locked page's title and URL.
    const fromLock = lockFor(locks, urlOf(rel))?.prefix ?? null;
    let lastHidden = null;
    const resolve = (t) => {
      const hit = index.get(t.toLowerCase());
      if (!hit) return null;
      if (visibleIn(locks, fromLock, hit.url)) return hit;
      lastHidden = t;
      return null;
    };
    const body = render(text, resolve, (t) => {
      broken.push({ from: rel, target: t, hidden: lastHidden === t });
      lastHidden = null;
    });
    bodies.set(rel, body);
    // index.md is the folder's own page; writeIndex composes it with the listing.
    if (basename(rel).toLowerCase() === "index.md") continue;
    const dir = dirname(rel);
    writeFileSync(
      join(repo, rel.replace(/\.md$/i, ".html")),
      shell({ title: titles.get(rel), body, up: dir === "." ? "/" : `/${dir}/` }),
    );
    rendered++;
  }

  // One index per directory that holds anything, plus the root.
  const dirs = new Set(sources.map((r) => dirname(r)));
  for (const dir of [...dirs].filter((d) => d !== ".")) {
    writeIndex(repo, dir, sources, titles, locks, bodies);
  }
  writeRootIndex(repo, sources, locks);

  if (!quiet) {
    console.log(`built ${rendered} page${rendered === 1 ? "" : "s"}, ${dirs.size} folder index(es)`);
    for (const b of broken) {
      console.warn(
        b.hidden
          ? `  warn: ${b.from} links to [[${b.target}]], which is locked and not visible from there — left unlinked`
          : `  warn: ${b.from} links to [[${b.target}]], which does not resolve`,
      );
    }
  }
  return { rendered, broken };
}

// An entry is listed only if it is no more secret than the page listing it.
const visibleIn = (locks, ownPrefix, url) => {
  const lock = lockFor(locks, url)?.prefix ?? null;
  return lock === null || lock === ownPrefix;
};

function writeIndex(repo, dir, sources, titles, locks, bodies) {
  const own = lockFor(locks, `/${dir}/`)?.prefix ?? null;
  const here = sources.filter((r) => dirname(r) === dir);
  const subdirs = [
    ...new Set(
      sources
        .filter((r) => r.startsWith(dir + "/") && dirname(r) !== dir)
        .map((r) => relative(dir, r).split(/[\\/]/)[0]),
    ),
  ].sort();

  const items = [
    ...subdirs
      .filter((d) => visibleIn(locks, own, `/${dir}/${d}/`))
      .map((d) => `  <li><a href="/${esc(dir)}/${esc(d)}/">${esc(d)}/</a></li>`),
    ...here
      .filter((r) => basename(r).toLowerCase() !== "index.md")
      .filter((r) => visibleIn(locks, own, urlOf(r)))
      .sort((a, b) => titles.get(a).localeCompare(titles.get(b)))
      .map((r) => {
        const kind = kindOf(r);
        const label = kind === "page" ? "" : ` <span class="type">${kind}</span>`;
        return `  <li><a href="${esc(urlOf(r))}">${esc(titles.get(r))}</a>${label}</li>`;
      }),
  ];

  const custom = here.find((r) => basename(r).toLowerCase() === "index.md");
  const intro = custom ? bodies.get(custom) : `<h1>/${esc(dir)}/</h1>`;

  writeFileSync(
    join(repo, dir, "index.html"),
    shell({
      title: `/${dir}/`,
      body: `${intro}\n<hr>\n<ul>\n${items.join("\n") || "  <li><em>Nothing here yet.</em></li>"}\n</ul>`,
      up: dirname(dir) === "." ? "/" : `/${dirname(dir)}/`,
    }),
  );
}

function writeRootIndex(repo, sources, locks) {
  const spaces = [...new Set(sources.map((r) => r.split(/[\\/]/)[0]).filter((s) => !s.includes(".")))]
    .filter((s) => visibleIn(locks, null, `/${s}/`))
    .sort();
  const items = spaces.length
    ? spaces.map((s) => `  <li><a href="/${esc(s)}/">/${esc(s)}/</a></li>`).join("\n")
    : "  <li><em>Nothing public here yet.</em></li>";
  writeFileSync(
    join(repo, "index.html"),
    shell({
      title: "dumpyard",
      body:
        `<h1>dumpyard</h1>\n<p class="meta">Pages, notes and files. Some of it is behind a password.</p>\n` +
        `<hr>\n<ul>\n${items}\n</ul>\n<p class="meta">Locked areas are deliberately not listed here.</p>`,
    }),
  );
}
