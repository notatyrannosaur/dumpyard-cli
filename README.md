# dumpyard

Publish pages, notes, PDFs and images to your own static site, with any folder
behind its own password.

```sh
npm install -g dumpyard
dumpyard publish ./project-xyz/ --set-password
```

```
locked /project-xyz/
password: m4hmU_WMJvhk
Shown once — it is stored nowhere and cannot be recovered.

https://my-site.you.workers.dev/project-xyz/
```

Send someone that link and that password. One password unlocks the whole
folder — every page, note, PDF and image under it.

## First-time setup

Four commands, no dashboard. You never open the Cloudflare UI, and there is no
Git integration to configure.

```sh
npm install -g dumpyard
npx wrangler login                 # browser OAuth, once per machine
dumpyard init --repo ~/my-site     # scaffold the repo
dumpyard deploy                    # first deploy
```

The last one prints your live URL — `https://<folder-name>.<your-subdomain>.workers.dev`
— and records it, so `dumpyard publish` can show you the right link from then on.
The Worker is named after the folder you scaffolded, so two sites never collide.

`wrangler login` stores an OAuth token under `~/Library/Preferences/.wrangler/`
(macOS) or `~/.config/.wrangler/`. Nothing is written into your repo, and you can
revoke it from the Cloudflare dashboard at any time. For CI, set a scoped
`CLOUDFLARE_API_TOKEN` with Workers Scripts:Edit instead — never the Global API
Key, which cannot be scoped and covers billing and DNS.

### Optional

**Keep history on GitHub.** `init` makes it a git repo but adds no remote. Make
the repo **private** — the edge password is pointless if the sources are
world-readable — then:

```sh
gh repo create <you>/my-site --private --source=. --remote=origin --push
```

Publishing pushes there too. Deployment does not depend on it.

**Custom domain.** Cloudflare dashboard -> your Worker -> Settings -> Domains &
Routes. Then `dumpyard init --repo ~/my-site --url https://your-domain` so links
point at it.

**Don't enable "Protect with Cloudflare Access"** if Cloudflare offers it. That
is account-level SSO sitting in front of the entire site, public pages included,
which replaces per-folder passwords rather than complementing them.

## Why there are no secrets to manage

The repo stores a **salted SHA-256 of each password, never the password**. A
hash is not a secret, so it lives in git and there is nothing to provision
anywhere. That matters because both obvious alternatives are capped: GitHub
allows 100 repository secrets (and they never reach a running site — they exist
only inside Actions runners), and Cloudflare allows 64 environment variables per
Worker on the free plan. Hashes in the repo have no such limit.

The hash is deliberately fast, which is only safe because `dumpyard` generates
the passwords — 72 bits of randomness, nothing to brute-force. Free Cloudflare
Pages Functions get 10ms of CPU per request, which rules out PBKDF2. If you
insist on choosing your own with `--password`, it must be 12+ characters.

## What it does

- **Markdown with `[[wikilinks]]`** — Obsidian-style, resolved at build time.
  `[[note]]`, `[[note|label]]`, `[[folder/note]]`, `![[diagram.png]]`. Broken
  links are reported, not silently dropped.
- **Generated indexes** for every folder, and for the site root.
- **Per-folder passwords**, longest-prefix-wins, so `/project-xyz/` can be
  locked while `/project-xyz/secret/` carries a second password on top.
- **Leak-resistant by construction.** A locked folder is left out of any index
  less secret than it is, and a public note cannot link into a locked folder —
  the link degrades to plain text rather than publishing a title and URL.
  Authenticated responses go out `private, no-store`.

## Commands

```
dumpyard publish <file|dir>...   add content and push
  --space <name>                 folder to publish into (default: the file's name)
  --set-password                 lock the space with a generated password
  --password <value>             lock it with your own (12+ characters)
  --no-push                      stage locally, don't push

dumpyard lock <path>             lock an existing path, e.g. /project-xyz/
dumpyard unlock <path>           make it public again
dumpyard list                    what is locked
dumpyard build                   re-render markdown and regenerate indexes
dumpyard init --repo <path>      scaffold a content repo and remember it
dumpyard upgrade                 refresh the gate and llms.txt from this CLI
```

## How the repo is laid out

```
wrangler.jsonc     Cloudflare config
worker/
  index.js         the gate — runs before anything is served
  hash.js
  locks.js         generated; salted hashes, never passwords
public/            the ONLY directory Cloudflare uploads
  index.html       generated
  <space>/         your content
```

The Worker source sits outside `public/`, so `locks.js` can never be fetched.

### The one line you must not delete

`wrangler.jsonc` contains:

```jsonc
"run_worker_first": true
```

Cloudflare serves matching static assets **before** the Worker by default. Without
this line the gate never runs and every locked page is served to anyone who asks —
silently, with no error. There is a test asserting it stays true.

## What this does not do

- **It cannot revoke a link someone already opened.** Changing a password stops
  future access, not a copy already downloaded.
- **No per-recipient identity, no expiry.** Anyone with the link and password
  can pass both on. If you need real identity, use Cloudflare Access instead.
- **HTTP Basic has no logout.** Closing the browser is the logout.

Good enough for sharing work with someone you trust. Not a substitute for
access control on anything that actually matters.

## Credit

Structure and spirit borrowed from Arnav Gupta's
[`championswimmer/sites.arnavg.in`](https://github.com/championswimmer/sites.arnavg.in).
No code was copied; the access control, markdown rendering and CLI are new.

## License

MIT
