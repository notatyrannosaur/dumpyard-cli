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
password: m4hmU_WMJvhk   (any username works at the prompt)
expires:  2026-10-05 09:00 UTC

Deployed. Live now.
```

One password unlocks everything in that folder. You can look it up again later
with `dumpyard password /project-xyz/`.

**This is for** sharing low-stakes work with people you trust. **It is not**
real access control. It has no per-person identity, and it can't take back a
copy someone already downloaded. See [What this does not do](#what-this-does-not-do).

## What you need

- **Node 20+** and **git**.
- **A Cloudflare account.** The free plan is enough, and dumpyard costs nothing
  on it. Its limits matter here:
  - **100,000 requests a day.** Every request to your site counts, images and
    PDFs included, because the password check has to run before anything is
    served. Past the limit, Cloudflare answers `429` until midnight UTC. The
    site goes dark rather than open.
  - **10 ms of CPU per request.** Enough for the password check, and the reason
    it uses a fast hash (see [How it works](#how-it-works)).
  - Other platform limits: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- A domain is optional. Without one you get a free `*.workers.dev` address.

## Install

```sh
npm install -g dumpyard
```

If that returns a 404, the package isn't on npm yet. Install from source:

```sh
git clone https://github.com/notatyrannosaur/dumpyard-cli
cd dumpyard-cli && npm install && npm install -g .
```

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
so printed links use the new domain. `deploy` never overwrites a URL you've set
yourself. With `routes` present, Cloudflare turns the `workers.dev` address off
unless you also add `"workers_dev": true` ([docs](https://developers.cloudflare.com/workers/wrangler/configuration/)).
*This hasn't been tried against a real domain yet.*

## Using it

```sh
dumpyard publish report.html                      # -> /report/
dumpyard publish ./project-xyz/ --set-password    # -> /project-xyz/, locked
dumpyard publish notes.md --space project-xyz     # -> /project-xyz/notes
dumpyard publish ./project-xyz/ --replace         # clear the folder first
```

Every command that changes the site commits, pushes if there's a remote, and
deploys. It ends by telling you whether the change is live:

| exit | last line | meaning |
|---|---|---|
| 0 | `Deployed. Live now.` | done |
| 0 | `Not deployed (--no-deploy)…` | you asked it not to deploy; nothing is live yet |
| 2 | `NOT DEPLOYED…` | committed locally, but the deploy failed; nothing is live |
| 1 | `error: …` | nothing changed |

An agent should hand over a link only on exit 0 with `Live now.`

### What you get at each URL

- **One page published without `--space`** becomes that folder's page, so
  `report.html` is served at `/report/`.
- **A folder** is served at `/folder/`.
  - If it has an `index.html`, that file is the page, and dumpyard never
    overwrites a file you wrote.
  - Otherwise you get a generated list of its contents.
  - An `index.md` becomes the page, with the list below it.
- **Markdown** `foo.md` becomes `/folder/foo`. Obsidian-style links work:
  `[[note]]`, `[[note|label]]`, `[[folder/note]]`, `![[diagram.png]]`. Broken
  links are reported, not dropped silently.
- **Everything else** (PDFs, images, your own HTML) is served as-is. A file
  published into an existing space prints its own URL.
- **Republishing adds to a folder.** Files you left out stay published.
  `--replace` clears the folder first and keeps its password.

## Passwords

```sh
dumpyard list                     # every lock, with password and expiry
dumpyard password /project-xyz/   # just the password
dumpyard status                   # setup and what's published, no passwords
```

Nobody memorises a generated password, and an agent that can't read one back
can't re-share the link. So the CLI keeps every password it issues in
`~/.config/dumpyard/passwords.json`, mode `0600`.

- **The store is kept out of the repo.** `init` refuses a repo that would
  contain it, because committing it would push your passwords to GitHub and
  deploy them.
- **Passwords are filed under the repo's full path on disk.** If you move or
  rename the site folder, `list` will show its locks as "not stored on this
  machine". Re-lock them, or edit the path in `passwords.json`.
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

- **Hashes in git, passwords on your machine.** `locks.js` holds a salted
  SHA-256 per locked folder. A hash isn't a secret, so it can sit in git, and
  there's no limit on how many folders you lock. The hash is deliberately fast
  so it fits the 10 ms CPU budget. That's only safe because generated passwords
  carry 72 bits of randomness. Hand-picked ones must be 12+ characters.
- **Nothing is served before the password check.** `wrangler.jsonc` sets
  `"run_worker_first": true`. By default Cloudflare serves matching files before
  the Worker runs, so without that line every locked page is public, with no
  error. A test fails if it ever changes. **Don't delete it.**
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
  --set-password                 lock the space with a generated password
  --password <value>             lock it with your own (12+ characters)
  --expires <when>               kill the link later: 30m, 12h, 7d, 2w, or a date
  --replace                      delete what's already in the space first
  --no-push                      don't push to git
  --no-deploy                    don't deploy to Cloudflare

dumpyard remove <path>           unpublish a folder or page
dumpyard lock <path>             lock a path, or rotate its password
  --password <value>
  --expires <when>
dumpyard unlock <path>           make it public again
dumpyard expire <path> <when>    change a locked path's expiry, or "never"
dumpyard prune                   remove everything whose link has expired
dumpyard list                    every lock, with its password and expiry
dumpyard password <path>         print one password, nothing else
dumpyard status                  is it set up, where, what's published (no passwords)
dumpyard build                   re-render markdown and regenerate indexes
dumpyard deploy                  deploy to Cloudflare with wrangler
dumpyard init --repo <path>      scaffold a content repo and remember it
  --url <https://...>            the site's public base URL
dumpyard upgrade                 refresh the gate and llms.txt from this CLI
dumpyard install-skill [--dir <path>]   copy the agent skill into ~/.claude/skills
```

## More than one site

A config directory holds one site. Give each site its own:

```sh
DUMPYARD_HOME=~/.config/dumpyard-work dumpyard init --repo ~/work-site
DUMPYARD_HOME=~/.config/dumpyard-work dumpyard publish ...
```

Or pass `--repo <path>` on each command. Passwords stay in the default
directory's store.

## Removing things, and tearing it all down

- `dumpyard remove /x/` takes something off the site. It stays in git history,
  including any remote you pushed to. Removing it from there means rewriting
  history.
- Expired content is removed only when you run `dumpyard prune`. Nothing runs it
  on a schedule.

To remove everything:

```sh
cd ~/my-site && npx wrangler@4.134.0 delete   # delete the Worker; the site goes offline
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

## License

MIT
