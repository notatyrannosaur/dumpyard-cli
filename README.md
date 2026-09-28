# dumpyard

[![test](https://github.com/notatyrannosaur/dumpyard-cli/actions/workflows/test.yml/badge.svg)](https://github.com/notatyrannosaur/dumpyard-cli/actions/workflows/test.yml)

A CLI for publishing pages, markdown notes, PDFs and images to your own site on
Cloudflare, with any folder behind its own password. Built so AI agents can
publish what they make and hand you a link and a password to send on.

```sh
dumpyard publish ./project-xyz/ --set-password --expires 7d
```

```
https://dumpyard-my-site.you.workers.dev/project-xyz/
password: orbit-cactus-mellow   (any username works at the prompt)
expires:  2026-10-05 09:00 UTC

Deployed. Live now.
```

One password unlocks everything in that folder. Passwords are three random
words, so they're easy to read out or type, and you can look one up again later
with `dumpyard password /project-xyz/`.

**This is for** sharing low-stakes work with people you trust. **It is not**
real access control. It has no per-person identity, and it can't take back a
copy someone already downloaded. See [What this does not do](#what-this-does-not-do).

## What you need

- **Node 20+**, and **git** with a name and email set (`git config --global
  user.name` / `user.email`). Every change is a commit, and dumpyard checks this
  before touching anything.
- **A Cloudflare account.** The free plan is enough, and dumpyard costs nothing
  on it. Its limits matter here:
  - **100,000 requests a day.** Every request to your site counts, images and
    PDFs included, because the password check has to run before anything is
    served. Past the limit, Cloudflare answers `429` until midnight UTC. The
    site goes dark rather than open.
  - **10 ms of CPU per request.** Enough for the password check, and the reason
    it uses a pepper rather than a slow hash (see [How it works](#how-it-works)).
  - Other platform limits: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- A domain is optional. Without one you get a free `*.workers.dev` address.

## Install

```sh
npm install -g dumpyard
```

If that returns a 404, the package isn't on npm yet. Install from a clone:

```sh
git clone https://github.com/notatyrannosaur/dumpyard-cli && cd dumpyard-cli
npm install && npm pack && npm install -g ./dumpyard-*.tgz
```

Installing the packed tarball copies the CLI, so you can delete the clone
afterwards. (`npm install -g .` also works, but it links to the clone, which
then has to stay put.) If your global npm directory is system-owned, you'll need
`sudo`, or a user-owned prefix.

## First-time setup

```sh
npx wrangler@4.134.0 login        # browser sign-in to Cloudflare, once per machine
dumpyard init --repo ~/my-site    # scaffold the site's git repo
dumpyard deploy                   # first deploy; prints and records your URL
```

That's all of it. You don't need the Cloudflare dashboard or any Git integration.

- **Your Worker is named `dumpyard-<folder>`**, e.g. `dumpyard-my-site`. Deploying
  replaces any Worker on your account with the same name, so the prefix keeps
  dumpyard away from Workers you already have. If you rename it in
  `wrangler.jsonc`, check that name isn't in use.
- **No Workers on this account yet?** Cloudflare needs a `workers.dev` subdomain
  first. If `deploy` stops and says so, run `npx wrangler@4.134.0 deploy` once
  inside `~/my-site` and pick one, then carry on.
- **Until the first deploy**, links print with a placeholder URL
  (`example.workers.dev`), and the CLI tells you so.
- **The first lock creates the site's pepper** (see [How it works](#how-it-works)),
  and the next deploy uploads it to Cloudflare as a secret. For those few
  seconds locked pages answer `503`. They never serve content without a
  password check.
- **Credentials.** `wrangler login` keeps an OAuth token in wrangler's own config
  (`~/Library/Preferences/.wrangler/` on macOS), never in your repo. You can
  revoke it from the Cloudflare dashboard. For CI, use a scoped
  `CLOUDFLARE_API_TOKEN` with *Workers Scripts: Edit*. Never use the Global API
  Key: it can't be scoped and covers billing and DNS.

### Optional

**Let your agent use it.**

```sh
dumpyard install-skill            # copies SKILL.md to ~/.claude/skills/dumpyard/
```

The skill tells an agent when to lock (by default), when to set an expiry (only
when you give a time limit), and what to hand back. `--dir <path>` installs it
somewhere else.

**Keep history on GitHub.** `init` creates a git repo but adds no remote. If you
add one, make it **private**. The password is pointless if the sources are
readable on GitHub.

```sh
cd ~/my-site && gh repo create <you>/my-site --private --source=. --remote=origin --push
```

After that, publishing pushes there too. Deploying doesn't depend on it.

**Custom domain.** The domain has to be on the same Cloudflare account. Add this
to `~/my-site/wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "share.example.com", "custom_domain": true }]
```

Then run `dumpyard deploy`, and `dumpyard init --repo ~/my-site --url https://share.example.com`
so printed links use the new domain. `deploy` checks your edited file first, and
refuses to run if `run_worker_first`, `assets.directory` or `main` changed. `deploy` never overwrites a URL you've set
yourself. With `routes` present, Cloudflare turns the `workers.dev` address off
unless you also add `"workers_dev": true` ([docs](https://developers.cloudflare.com/workers/wrangler/configuration/)).
*This hasn't been tried against a real domain yet.*

## Using it

```sh
dumpyard publish report.html                      # -> /report/
dumpyard publish ./project-xyz/ --set-password    # -> /project-xyz/, locked
dumpyard publish notes.md --space project-xyz --update   # add to an existing space
dumpyard publish ./project-xyz/ --replace         # clear the space first
```

Every command that changes the site commits, pushes if there's a remote, and
deploys. It ends by telling you whether the change is live:

| exit | last line | meaning |
|---|---|---|
| 0 | `Deployed. Live now.` | done |
| 0 | `Not deployed (--no-deploy)…` | you asked it not to deploy; nothing is live yet |
| 2 | `NOT DEPLOYED…` | committed locally, but the deploy failed; nothing is live |
| 1 | `error: …` | refused before changing anything |

An agent should hand over a link only on exit 0 with `Live now.`

### What you get at each URL

- **One page published without `--space`** becomes that folder's page, so
  `report.html` is served at `/report/`.
- **A folder** is served at `/folder/`.
  - If it has an `index.html`, that file is the page, and dumpyard never
    overwrites a file you wrote. Nothing is generated inside such a folder.
  - Otherwise you get a generated list of its contents.
  - An `index.md` becomes the page, with the list below it.
- **Markdown** `foo.md` becomes `/folder/foo`. Obsidian-style links work:
  `[[note]]`, `[[note|label]]`, `[[folder/note]]`, `![[diagram.png]]`. A link
  resolves in the note's own folder first, then its space, then the whole
  site. Ambiguous and broken links are reported.
- **Everything else** (PDFs, images, your own HTML) is served as-is. A file
  published into an existing space prints its own URL.

### Publishing into a space that already exists

`publish` refuses an existing space unless you say what you mean. An accidental
overwrite can't happen.

- `--update` adds files and overwrites same-named ones. Files you left out stay
  published.
- `--replace` clears the space first.

Either way the space keeps its password. `--set-password` on an already-locked
space leaves the password alone, so people you've already sent the link to
aren't locked out by an update. To change a password, run `dumpyard lock` again.
It prints `ROTATED` and a new password.

## Passwords

```sh
dumpyard list                     # every lock, with password and expiry
dumpyard password /project-xyz/   # just the password
dumpyard status                   # setup and what's published, no passwords
```

Only **folders** can be locked. A lock covers everything inside the folder,
including markdown sources and assets. Put a page you want locked on its own
into a space of its own.

Generated passwords are three random words from the
[EFF long wordlist](https://www.eff.org/dice), such as `orbit-cactus-mellow`.
That's about 39 bits: plenty against guessing over the internet, which
Cloudflare caps at 100k requests a day. A hand-picked one (`--password`) must be
12+ characters and not repetitive. `--password -` reads it from stdin, which
keeps it out of your shell history.

Nobody memorises a generated password, and an agent that can't read one back
can't re-share the link. So the CLI keeps every password it issues in
`passwords.json` inside `~/.config/dumpyard/` (mode `0600`). `peppers.json`
sits next to it.

- **The store is kept out of the repo.** `init` refuses a repo that would
  contain it, because committing it would push your passwords to GitHub and
  deploy them.
- **Moving to another machine means copying `~/.config/dumpyard/`.** Without
  the site's pepper, a machine can't create or check passwords. dumpyard refuses
  rather than invent a new pepper, which would break every existing password.
- **Passwords are filed under the repo's full path on disk.** If you move or
  rename the site folder, its locks show as "not stored on this machine". Re-lock
  them, or edit the path in both files. `status` lists stored secrets whose
  folder is gone.
- **Your own disk is inside the trust boundary; the internet is outside it.** If
  that doesn't match your threat model (a shared machine, untrusted local users),
  this is the wrong tool.

## Expiring links

```sh
dumpyard publish ./draft/ --set-password --expires 7d   # 30m, 12h, 7d, 2w, or 2026-10-01 (UTC)
dumpyard expire /draft/ 3d                              # change it; "never" clears it
dumpyard prune                                          # delete what has expired
```

When a link expires, everything in that folder returns `410 Gone`, even to
someone with the right password. This happens on the next request, with no
redeploy. The files stay deployed until `prune` removes them.

Expiry works only on locked folders. An expiry rule without a password could
make a subfolder of a locked folder public. Rotating a password (`lock` again)
keeps the old expiry, so it can't be used to extend a link.

## How it works

```
~/my-site/
  wrangler.jsonc   Cloudflare config
  worker/          the gate; never uploaded as a file
    index.js         checks every request before anything is served
    locks.js         salted password hashes (generated)
  public/          the only directory Cloudflare serves
  llms.txt         instructions for agents working in this repo
```

- **Hashes in git, passwords on your machine, pepper in Cloudflare.**
  `locks.js` holds `HMAC-SHA256(pepper, salt:password)` per locked folder. The
  pepper is one random 256-bit secret per site. It lives in Cloudflare as the
  `DUMPYARD_PEPPER` secret, which can't be read back out, and in your
  `~/.config/dumpyard`. It is never in the repo. So a leaked repo is useless for
  cracking, even though three words is only ~39 bits and HMAC is fast.
  - **Why not slow hashing?** A slow hash (PBKDF2, bcrypt) doesn't fit the free
    plan's 10 ms CPU budget, and a pepper does.
  - **What locks.js reveals:** the hashes can sit in git, and there's no limit
    on how many folders you lock.
  - **If Cloudflare loses the pepper,** locked pages answer `503`: closed, never
    open.
- **Nothing is served before the password check.** `wrangler.jsonc` sets
  `"run_worker_first": true`. By default Cloudflare serves matching files before
  the Worker runs, so without that line every locked page is public, with no
  error. `dumpyard deploy` refuses to deploy a site whose `wrangler.jsonc` lacks
  it, and the template has a test. **Don't delete it.**
- **Tricks in the URL don't get past the gate.** It decodes and normalises the
  path before matching: `%2e%2e`, `//`, double encoding and letter case all hit
  the same lock.
- **Locked pages stay off public pages.**
  - Indexes never list anything more locked than themselves.
  - A `[[wikilink]]` from a public page into a locked folder is left unlinked.
  - A plain link that does the same is flagged at build time, not rewritten:
    the build can't safely edit arbitrary HTML. Treat that warning as a leak.
  - Password-protected responses are sent `private, no-store`, so nothing
    caches them.
- **Only open content repos you trust.** The CLI reads `worker/locks.js` by
  running it as JavaScript, so opening a site repo runs its code.

## Commands

```
dumpyard publish <file|dir>...   add content, commit, push and deploy
  --space <name>                 folder to publish into (default: the file's name)
  --update                       add to a space that already exists
  --replace                      clear a space that already exists first
  --set-password                 lock the space (keeps its password if already locked)
  --password <value|->           lock it with your own password; - reads it from stdin
  --expires <when>               kill the link later: 30m, 12h, 7d, 2w, or a date
  --no-push                      don't push to git
  --no-deploy                    don't deploy to Cloudflare

dumpyard remove <path>           unpublish a folder or page
dumpyard lock <folder>           lock a folder, or rotate its password
  --password <value|->
  --expires <when>
dumpyard unlock <folder>         make it public again
dumpyard expire <folder> <when>  change a locked folder's expiry, or "never"
dumpyard prune                   remove everything whose link has expired
dumpyard list                    every lock, with its password and expiry
dumpyard password <folder>       print one password, nothing else
dumpyard status                  is it set up, where, what's published (no passwords)
dumpyard build                   re-render markdown and regenerate indexes
dumpyard deploy                  deploy to Cloudflare with wrangler
dumpyard init --repo <path>      scaffold a content repo and remember it
  --url <https://...>            the site's public base URL
dumpyard upgrade                 refresh the gate and llms.txt from this CLI
dumpyard install-skill [--dir <path>]   copy the agent skill into ~/.claude/skills

Any command:  --repo <path>  use this site instead of the remembered one
              -m, --message <text>  commit message
```

## More than one site

A config directory holds one site. Give each site its own:

```sh
DUMPYARD_HOME=~/.config/dumpyard-work dumpyard init --repo ~/work-site
DUMPYARD_HOME=~/.config/dumpyard-work dumpyard publish ...
```

Each `DUMPYARD_HOME` has its own config, passwords and peppers. Or pass
`--repo <path>` on each command, which keeps everything in the default
directory. A second `init` without either repoints the default at the new
site, and says so.

## Removing things, and tearing it all down

- `dumpyard remove /x/` takes something off the site. It stays in git history,
  including any remote you pushed to. Removing it from there means rewriting
  history.
- Expired content is removed only when you run `dumpyard prune`. Nothing runs it
  on a schedule.

To remove everything:

```sh
cd ~/my-site && npx wrangler@4.134.0 delete   # delete the Worker (and its pepper); the site goes offline
rm -rf ~/my-site ~/.config/dumpyard           # the repo, config and passwords
rm -rf ~/.claude/skills/dumpyard              # the agent skill, if you installed it
npx wrangler@4.134.0 logout                   # revoke wrangler's Cloudflare token
npm uninstall -g dumpyard
```

## What this does not do

- **It can't take back a copy already downloaded.** Changing a password,
  expiring a link or running `remove` stops future access only.
- **No per-person identity.** Anyone with the link and password can pass both
  on until the link expires. For real identity, use Cloudflare Access.
- **No logout.** HTTP Basic has none; closing the browser is the logout.

## Credit

Structure and spirit borrowed from Arnav Gupta's
[`championswimmer/sites.arnavg.in`](https://github.com/championswimmer/sites.arnavg.in).
No code was copied; the access control, markdown rendering and CLI are new.

Generated passwords use the [EFF Long Wordlist](https://www.eff.org/dice) by
the Electronic Frontier Foundation, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The copy in
`src/wordlist.txt` drops the four hyphenated words so that passphrases split
unambiguously.

## License

MIT (the wordlist: CC BY 4.0, as above)
