// Walk public/, render markdown, regenerate indexes, clean up after itself.
//
// Every file this build writes carries GENERATOR, and the build only ever
// overwrites or deletes files that carry it. So:
//   foo.md       -> foo.html, unless you wrote a foo.html yourself (yours wins)
//   index.html   -> generated listing, unless you wrote one yourself (yours wins)
//   index.md     -> becomes the folder's page, with the listing below it
//   anything else is served as-is (PDFs, images, hand-written HTML)
//
// A listing shows an entry only if that entry is no more secret than the page
// listing it, so a public index never names a locked page. Links from a page
// into something more secret are dropped (wikilinks) or warned about (plain).
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync, rmdirSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { render, titleOf } from "./markdown.mjs";
import { load as loadLocks } from "./locks.mjs";
import { lockFor } from "../templates/worker/hash.js";

const GENERATOR = '<meta name="generator" content="dumpyard">';
// Sites built before the marker existed are recognised by their footer.
const GENERATED = /<meta name="generator" content="dumpyard">|<footer>Built by dumpyard\.<\/footer>/;
const ROOT_FILES = new Set(["index.html", "404.html", "robots.txt"]);
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// Percent-encode each segment, so "My Report.pdf" makes a working link.
const href = (url) => url.split("/").map(encodeURIComponent).join("/");

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
${GENERATOR}
<title>${esc(title)}</title>
<style>${STYLE}
</style>
</head>
<body>
${up ? `<p class="meta"><a href="${esc(href(up))}">&larr; up</a></p>\n` : ""}${body}
<footer>Built by dumpyard.</footer>
</body>
</html>
`;

function walk(dir, root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    const rel = relative(root, full).split("\\").join("/");
    if (e.isDirectory()) walk(full, root, out);
    else if (!(!rel.includes("/") && ROOT_FILES.has(e.name))) out.push(rel);
  }
  return out;
}

// The URL a source is served at. Cloudflare serves foo.html at /foo (and
// redirects the .html form), so link there directly. Only a lowercase .html is
// stripped: an uppercase .HTML isn't served extensionless, so it keeps its name.
export const urlOf = (rel) => {
  const p = "/" + rel.replace(/\.md$/i, ".html");
  return p.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
};
const isPage = (rel) => /\.(md|html?)$/i.test(rel);
const kindOf = (rel) =>
  isPage(rel) ? "page" : IMAGE.test(rel) ? "image" : /\.pdf$/i.test(rel) ? "pdf" : "file";
const isGenerated = (file) => existsSync(file) && GENERATED.test(readFileSync(file, "utf8"));
const TITLE = /<title>(.*?)<\/title>/is;

// An entry is shown only if it is no more secret than the page showing it.
const visibleIn = (locks, ownPrefix, url) => {
  const lock = lockFor(locks, url)?.prefix ?? null;
  return lock === null || lock === ownPrefix;
};

export async function build(repo, { quiet = false } = {}) {
  const locks = await loadLocks(repo);
  // Only ./public is uploaded to Cloudflare, so only ./public is content.
  const root = join(repo, "public");
  const at = (rel) => join(root, rel);
  const all = walk(root, root);
  const warnings = [];
  const warn = (from, message) => warnings.push({ from, message });

  // Split what's here into your files (sources) and this build's old output.
  const mds = new Set(all.filter((r) => /\.md$/i.test(r)).map((r) => r.replace(/\.md$/i, "")));
  const ownHtml = new Set(); // hand-written .html that shadows a .md or the listing
  const sources = [];
  for (const rel of all) {
    if (/\.html$/i.test(rel) && isGenerated(at(rel))) continue; // old output
    if (/\.html$/i.test(rel) && mds.has(rel.replace(/\.html$/i, ""))) ownHtml.add(rel);
    sources.push(rel);
  }
  // A .md whose .html you wrote by hand is not rendered — yours wins.
  const renderable = sources.filter((r) => {
    if (!/\.md$/i.test(r)) return false;
    const out = r.replace(/\.md$/i, ".html");
    if (basename(r).toLowerCase() === "index.md") {
      if (sources.includes(join(dirname(r), "index.html").replace(/^\.\//, ""))) {
        warn(r, `ignored: ${out} is your own file, so it is the folder page`);
        return false;
      }
      return true;
    }
    if (ownHtml.has(out)) {
      warn(r, `not rendered: ${out} is your own file and would be overwritten`);
      return false;
    }
    return true;
  });
  const served = sources.filter((r) => !(/\.md$/i.test(r) && !renderable.includes(r)));

  // Titles, and the wikilink index: bare name, filename, "folder/name" and the
  // full path, each mapping to every page that answers to it.
  const titles = new Map();
  const index = new Map();
  const add = (key, entry) => {
    const k = key.toLowerCase();
    if (!index.has(k)) index.set(k, []);
    if (!index.get(k).includes(entry)) index.get(k).push(entry);
  };
  for (const rel of served) {
    const stem = basename(rel).replace(/\.(md|html?)$/i, "");
    let title = stem;
    if (/\.md$/i.test(rel)) title = titleOf(readFileSync(at(rel), "utf8"), stem);
    else if (/\.html?$/i.test(rel)) title = TITLE.exec(readFileSync(at(rel), "utf8"))?.[1]?.trim() || stem;
    titles.set(rel, title);
    const entry = { url: urlOf(rel), title, rel };
    add(stem, entry);
    add(basename(rel), entry);
    add(`${dirname(rel).split("/").pop()}/${stem}`, entry);
    add(rel, entry);
  }
  // Resolve a link the way a reader expects: the linking note's own folder
  // first, then its space, then the whole site. Without this, publishing an
  // unrelated space could silently repoint [[index]] in another one.
  const spaceOf = (rel) => rel.split("/")[0];
  const lookup = (target, from) => {
    const all = index.get(target.toLowerCase()) ?? [];
    for (const pool of [
      all.filter((e) => dirname(e.rel) === dirname(from)),
      all.filter((e) => spaceOf(e.rel) === spaceOf(from)),
      all,
    ]) {
      if (pool.length === 1) return pool[0];
      if (pool.length > 1) {
        warn(from, `[[${target}]] matches ${pool.length} pages; linked ${pool[0].url}. Write [[folder/name]] to choose.`);
        return pool[0];
      }
    }
    return null;
  };

  const outputs = new Set(["index.html"]);
  const bodies = new Map();
  for (const rel of renderable) {
    const text = readFileSync(at(rel), "utf8");
    const fromLock = lockFor(locks, urlOf(rel))?.prefix ?? null;
    let hidden = null;
    const resolve = (t) => {
      const hit = lookup(t, rel);
      if (!hit) return null;
      if (visibleIn(locks, fromLock, hit.url)) return { ...hit, url: href(hit.url) };
      hidden = t;
      return null;
    };
    const body = render(text, resolve, (t) => {
      warn(
        rel,
        hidden === t
          ? `[[${t}]] points into a locked folder, so it was left unlinked`
          : `[[${t}]] does not resolve`,
      );
      hidden = null;
    });
    bodies.set(rel, body);
    if (basename(rel).toLowerCase() === "index.md") continue; // folded into the listing
    const out = rel.replace(/\.md$/i, ".html");
    const dir = dirname(rel);
    writeFileSync(at(out), shell({ title: titles.get(rel), body, up: dir === "." ? "/" : `/${dir}/` }));
    outputs.add(out);
  }

  // Plain links can point into a locked folder too. Rewriting arbitrary HTML
  // is guesswork, so these are flagged loudly instead.
  for (const rel of served.filter(isPage)) {
    const page = urlOf(rel);
    const fromLock = lockFor(locks, page)?.prefix ?? null;
    const html = /\.md$/i.test(rel) ? (bodies.get(rel) ?? "") : readFileSync(at(rel), "utf8");
    for (const [, link] of html.matchAll(/(?:href|src)\s*=\s*["']([^"'#?]+)/gi)) {
      let target;
      try {
        const u = new URL(link, `https://site.invalid${page}`);
        if (u.host !== "site.invalid") continue; // off-site
        target = u.pathname;
      } catch {
        continue;
      }
      if (!visibleIn(locks, fromLock, target)) {
        warn(rel, `links to ${target}, which is locked — that URL is visible to anyone reading this page`);
      }
    }
  }

  // One listing per folder that has content, unless you wrote its index.html.
  const dirs = new Set();
  for (const r of served) for (let d = dirname(r); d !== "."; d = dirname(d)) dirs.add(d);
  // A folder with its own index.html is an app: it gets no listing, and
  // neither does anything inside it (no generated page in its js/ folder).
  const apps = [...dirs].filter((d) => served.includes(`${d}/index.html`));
  for (const dir of dirs) {
    if (apps.some((a) => dir === a || dir.startsWith(`${a}/`))) continue; // yours
    writeIndex(root, dir, served, titles, locks, bodies);
    outputs.add(`${dir}/index.html`);
  }
  writeRootIndex(root, served, locks);

  // Delete this build's leftovers: generated files nothing produces any more,
  // then any folder that is now empty. Your files are never touched.
  let cleaned = 0;
  for (const rel of all) {
    if (/\.html$/i.test(rel) && !outputs.has(rel) && isGenerated(at(rel))) {
      rmSync(at(rel));
      cleaned++;
    }
  }
  pruneEmpty(root, root);

  if (!quiet) {
    console.log(`built ${bodies.size} note(s), ${dirs.size} folder(s)${cleaned ? `, cleaned ${cleaned} stale file(s)` : ""}`);
    for (const w of warnings) console.warn(`  warn: ${w.from}: ${w.message}`);
  }
  return { warnings, broken: warnings };
}

function pruneEmpty(dir, root) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmpty(join(dir, e.name), root);
  }
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
}

function writeIndex(root, dir, served, titles, locks, bodies) {
  const own = lockFor(locks, `/${dir}/`)?.prefix ?? null;
  const here = served.filter((r) => dirname(r) === dir);
  const subdirs = [
    ...new Set(served.filter((r) => r.startsWith(dir + "/") && dirname(r) !== dir).map((r) => r.slice(dir.length + 1).split("/")[0])),
  ].sort();

  const items = [
    ...subdirs
      .filter((d) => visibleIn(locks, own, `/${dir}/${d}/`))
      .map((d) => `  <li><a href="${esc(href(`/${dir}/${d}/`))}">${esc(d)}/</a></li>`),
    ...here
      .filter((r) => basename(r).toLowerCase() !== "index.md")
      .filter((r) => visibleIn(locks, own, urlOf(r)))
      .sort((a, b) => titles.get(a).localeCompare(titles.get(b)))
      .map((r) => {
        const kind = kindOf(r);
        const label = kind === "page" ? "" : ` <span class="type">${kind}</span>`;
        return `  <li><a href="${esc(href(urlOf(r)))}">${esc(titles.get(r))}</a>${label}</li>`;
      }),
  ];

  const custom = here.find((r) => basename(r).toLowerCase() === "index.md");
  const intro = custom && bodies.has(custom) ? bodies.get(custom) : `<h1>/${esc(dir)}/</h1>`;
  writeFileSync(
    join(root, dir, "index.html"),
    shell({
      title: `/${dir}/`,
      body: `${intro}\n<hr>\n<ul>\n${items.join("\n") || "  <li><em>Nothing here yet.</em></li>"}\n</ul>`,
      up: dirname(dir) === "." ? "/" : `/${dirname(dir)}/`,
    }),
  );
}

function writeRootIndex(root, served, locks) {
  const spaces = [...new Set(served.filter((r) => r.includes("/")).map((r) => r.split("/")[0]))]
    .filter((s) => visibleIn(locks, null, `/${s}/`))
    .sort();
  const items = spaces.length
    ? spaces.map((s) => `  <li><a href="${esc(href(`/${s}/`))}">/${esc(s)}/</a></li>`).join("\n")
    : "  <li><em>Nothing public here yet.</em></li>";
  writeFileSync(
    join(root, "index.html"),
    shell({
      title: "dumpyard",
      body:
        `<h1>dumpyard</h1>\n<p class="meta">Pages, notes and files. Some of it is behind a password.</p>\n` +
        `<hr>\n<ul>\n${items}\n</ul>\n<p class="meta">Locked areas are deliberately not listed here.</p>`,
    }),
  );
}
