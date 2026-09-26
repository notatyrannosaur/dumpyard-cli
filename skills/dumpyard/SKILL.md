---
name: dumpyard
description: Publish an artifact you made (HTML page, markdown notes, PDF, images, or a folder of them) to the user's dumpyard site, optionally behind a password and with an expiry, and hand back the link. Use when the user asks to publish, share, host, upload or "send a link to" something you produced, or to look up, change, expire or remove something already published.
---

# dumpyard

`dumpyard` is a CLI that publishes files to the user's static site on
Cloudflare. Any folder can have its own password, and one password covers
everything under that folder. Run `dumpyard --help` for the full command list.

## 1. Check it is set up

```sh
dumpyard list
```

If the command is missing or says "no content repo configured", **stop** and
tell the user to follow the first-time setup at
https://github.com/notatyrannosaur/dumpyard-cli#first-time-setup. Do not run
`init` or `wrangler login` yourself. Login opens a browser, and `init` creates
repos the user should choose.

## 2. Make the artifact

Write it somewhere outside the content repo, such as a temp folder, then
publish it from there.

- **HTML**: one self-contained file. Inline CSS and JS, no frameworks, no
  external requests.
- **Markdown**: start every note with `# Heading`, which becomes its title.
  Link notes with `[[note]]` or `[[note|label]]`, and embed images with
  `![[diagram.png]]`.
- **Images and PDFs**: put them next to the pages that use them.
- **Several related files**: put them in one folder and publish the folder.

## 3. Publish

```sh
dumpyard publish ./artifact/ --space <kebab-name> --set-password
dumpyard publish report.html --space <kebab-name> --set-password --expires 7d
dumpyard publish page.html --space <kebab-name>              # public
```

This one command builds, commits, pushes and deploys. The link is live when it
finishes.

**Lock it unless the user said it can be public.** Locking something that
should be public is fixed with one `unlock`. Publishing something that should
be private cannot be undone, because anyone may already have fetched it.

**Add `--expires` only when the user gives a time limit**, such as "for the
week", "temporarily" or "until Friday". Accepted values: `30m`, `12h`, `7d`,
`2w`, or a date like `2026-10-01` (UTC). Expiry only works on locked folders.

**Choose a new space name** unless the user wants to update an existing
publication. `publish` prints `updating existing /name/` when the folder
already exists. If you did not intend that, stop and ask. Republishing to the
same space keeps its password.

## 4. Hand it over

Every time you publish, give the user:

- the URL the command printed
- the password, if the folder is locked. Any username works at the prompt.
- the expiry, if one is set
- what is public and what is locked

Passwords can always be looked up again, so you never need to warn that one is
unrecoverable:

```sh
dumpyard password /<space>/     # one password
dumpyard list                   # every lock, with password and expiry
```

Locked folders do not appear on the site's public index, so the URL is the
only way in.

## Changing things later

```sh
dumpyard expire /<space>/ 3d        # set or change expiry ("never" clears it)
dumpyard lock /<space>/             # add a password, or rotate an existing one
dumpyard unlock /<space>/           # make it public
dumpyard remove /<space>/           # take it off the site
dumpyard prune                      # remove everything that has expired
```

Run `remove` and `prune` only when the user asks. Content stays in git
history, but the live link is gone as soon as the command finishes.

## Never

- Edit files inside the content repo by hand. Use the CLI.
- Put a password in a file, a commit message or a published page. Giving it to
  the user in chat is fine.
- Publish credentials, private keys or other people's personal data, even
  behind a password.
