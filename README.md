# dumpyard

[![test](https://github.com/notatyrannosaur/dumpyard-cli/actions/workflows/test.yml/badge.svg)](https://github.com/notatyrannosaur/dumpyard-cli/actions/workflows/test.yml)

Publish pages, notes, PDFs and images to your own static site, with any folder
behind its own password.

```sh
npm install -g dumpyard
dumpyard publish ./project-xyz/ --set-password
```

```
https://my-site.you.workers.dev/project-xyz/
password: m4hmU_WMJvhk   (any username works at the prompt)
```

Send someone that link and that password. One password unlocks the whole
folder — every page, note, PDF and image under it.

Forgot it? `dumpyard password /project-xyz/`. Passwords are kept, not thrown
away — see below.

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

**Use it from an agent.** The package ships a skill for Claude Code (and anything
else that reads `SKILL.md`). It covers when to lock, when to set an expiry, and
what to hand back:

```sh
mkdir -p ~/.claude/skills/dumpyard
cp "$(npm root -g)/dumpyard/skills/dumpyard/SKILL.md" ~/.claude/skills/dumpyard/
```

**Custom domain.** The domain's zone must be on the same Cloudflare account. Add
it to `wrangler.jsonc` in your content repo:

```jsonc
"routes": [{ "pattern": "share.example.com", "custom_domain": true }]
```

Then run `dumpyard deploy` so Cloudflare creates the DNS record and certificate,
and `dumpyard init --repo ~/my-site --url https://share.example.com` so printed
links use it. `deploy` never overwrites a custom URL with the `workers.dev` one.
The site stays reachable at both hosts, gated the same way, unless you also set
`"workers_dev": false`. *(Written from Cloudflare's docs. It hasn't been run
against a real domain yet.)*

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

## Passwords are retrievable

```sh
dumpyard list                     # every lock, with its password
dumpyard password /project-xyz/   # just the password
```

This is a tool for publishing agent-generated artifacts. Nobody memorises a
generated password, and an agent that cannot read one back cannot re-share the
link — so the CLI keeps every password it issues in
`~/.config/dumpyard/passwords.json`, mode `0600`.

That file lives in `~/.config`, **never** inside the content repo. `init`
refuses a repo that would contain it, because committing it would push your
passwords to your git host and deploy them to the edge. Point it elsewhere with
`DUMPYARD_HOME` if you keep separate profiles.

The trust boundary is the public internet, not your own disk. If that is not
your threat model — shared machine, untrusted local users — this is the wrong
tool.

## Expiring links

```sh
dumpyard publish ./draft/ --set-password --expires 7d
dumpyard expire /draft/ 2026-10-01      # change it; "never" clears it
dumpyard prune                          # delete everything that has expired
```

Once a link expires, every URL under that folder returns `410 Gone`, **even
with the right password**. The Worker enforces this on each request, so no
redeploy is needed at the moment of expiry. `prune` then removes the content
itself. Until you run it, the files stay deployed but can't be reached.

Expiry works only on locked folders. Allowing it on public ones would need a
rule with no password, and with longest-prefix-wins, that rule could make a
subfolder of a locked folder public. Rotating a password keeps the existing
expiry, so re-locking never extends a link's life.

## Commands

```
dumpyard publish <file|dir>...   add content, commit, push and deploy
  --space <name>                 folder to publish into (default: the file's name)
  --set-password                 lock the space with a generated password
  --password <value>             lock it with your own (12+ characters)
  --expires <when>               kill the link later: 30m, 12h, 7d, 2w, or a date
  --no-push                      don't push to git
  --no-deploy                    don't deploy to Cloudflare

dumpyard remove <path>           unpublish a folder or page, and deploy
dumpyard lock <path>             lock an existing path, e.g. /project-xyz/
  --password <value>
  --expires <when>
dumpyard unlock <path>           make it public again
dumpyard expire <path> <when>    change a locked path's expiry, or "never"
dumpyard prune                   remove everything whose link has expired
dumpyard list                    every lock, with its password and expiry
dumpyard password <path>         print one password, nothing else
dumpyard build                   re-render markdown and regenerate indexes
dumpyard deploy                  deploy to Cloudflare with wrangler
dumpyard init --repo <path>      scaffold a content repo and remember it
  --url <https://...>            the site's public base URL
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

- **It cannot revoke a link someone already opened.** Changing a password or
  running `remove` stops future access, not a copy already downloaded.
- **No per-recipient identity.** Anyone with the link and password can pass
  both on until it expires. If you need real identity, use Cloudflare Access.
- **HTTP Basic has no logout.** Closing the browser is the logout.

Good enough for sharing work with someone you trust. Not a substitute for
access control on anything that actually matters.

## Credit

Structure and spirit borrowed from Arnav Gupta's
[`championswimmer/sites.arnavg.in`](https://github.com/championswimmer/sites.arnavg.in).
No code was copied; the access control, markdown rendering and CLI are new.

## License

MIT
