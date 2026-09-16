// Markdown → HTML, with Obsidian-style [[wikilinks]].
//
//   [[note]]            link to note, labelled with its title
//   [[note|Label]]      link with your own label
//   [[folder/note]]     disambiguate when two notes share a name
//   ![[diagram.png]]    embed an image
//   ![[spec.pdf]]       link a PDF
//
// Implemented as a marked extension rather than a regex pass over the source,
// so [[this]] inside a code fence stays literal.
import { Marked } from "marked";

const WIKILINK = /^(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const anchor = (s) => s.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");

// resolve(target) -> { url, title } | null
export function render(text, resolve, onBroken = () => {}) {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src) => src.match(/!?\[\[/)?.index,
        tokenizer(src) {
          const m = WIKILINK.exec(src);
          if (!m) return;
          return {
            type: "wikilink",
            raw: m[0],
            embed: m[1] === "!",
            target: m[2].trim(),
            hash: m[3]?.trim(),
            label: m[4]?.trim(),
          };
        },
        renderer(tok) {
          const hit = resolve(tok.target);
          if (!hit) {
            onBroken(tok.target);
            return `<span class="broken" title="unresolved link">${escape(
              tok.label ?? tok.target,
            )}</span>`;
          }
          const href = escape(hit.url + (tok.hash ? `#${anchor(tok.hash)}` : ""));
          if (tok.embed && IMAGE.test(hit.url)) {
            return `<img src="${href}" alt="${escape(tok.label ?? hit.title)}" loading="lazy">`;
          }
          return `<a href="${href}">${escape(tok.label ?? hit.title)}</a>`;
        },
      },
    ],
  });
  return marked.parse(text);
}

// First "# heading", else the slug. Used for the <title> and for link labels.
export function titleOf(text, fallback) {
  const m = /^\s{0,3}#\s+(.+?)\s*$/m.exec(text);
  return m ? m[1].replace(/\s+/g, " ").trim() : fallback;
}
