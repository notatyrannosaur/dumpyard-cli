---
name: dumpyard
description: Publish an artifact you made (HTML page, markdown notes, PDF, images, or a folder of them) to the user's dumpyard site, optionally behind a password and with an expiry, and hand back the link. Use when the user asks to publish, share, host, upload or "send a link to" something you produced, or to look up, change, expire or remove something already published.
---

# dumpyard

`dumpyard` is a CLI that publishes files to the user's own site on Cloudflare.
Any folder can have its own password, and one password covers everything in
that folder. `dumpyard --help` lists every command.

## 1. Check it's set up

```sh
dumpyard status
```

This prints the repo, the site URL and what's published, without any
passwords. **Stop and tell the user** if:

- the command isn't found, or
- it says "no content repo configured", or
- it says the site is "not deployed yet".

Point them to https://github.com/notatyrannosaur/dumpyard-cli#first-time-setup.
Don't run `init`, `deploy` or `wrangler login` yourself: signing in opens a
browser, and setup creates things the user should choose.

## 2. Make the artifact

Write it outside the site repo (a temp folder is fine) and publish from there.

- **HTML**: one self-contained file with inline CSS and JS, no frameworks, no
  external requests. For a multi-file app, a folder whose `index.html` is the
  entry point. dumpyard never overwrites a file you wrote.
- **Markdown**: start every note with `# Heading`, which becomes its title.
  Link notes with `[[note]]` or `[[note|label]]`, and embed images with
  `![[diagram.png]]`.
- **Images and PDFs**: put them next to the pages that use them.

## 3. Publish

```sh
dumpyard publish report.html --set-password                   # -> /report/
dumpyard publish ./artifact/ --space <kebab-name> --set-password
dumpyard publish ./artifact/ --space <kebab-name> --set-password --expires 7d
```

**Lock it unless the user said it may be public.** A mistaken lock is fixed
with one `unlock`. A mistaken public publish can't be undone, because anyone may
already have a copy.

**Add `--expires` only when the user gives a time limit**, such as "for the
week", "temporarily" or "until Friday". Accepted values: `30m`, `12h`, `7d`,
`2w`, or a date like `2026-10-01` (UTC). Expiry works only on locked folders.

**Pick a new space name** unless you're updating an existing publication. If
the output says `updating existing /name/` and you didn't intend that, stop and
ask. Republishing adds files and keeps the password. `--replace` clears the
folder first.

**Check that it's live before handing anything over.** It is live only if the
command exits 0 and its last line is `Deployed. Live now.`

- Exit 2 or `NOT DEPLOYED`: nothing is live. Tell the user what failed, and
  don't give them the link as if it works.
- A build warning that a page links into a locked path: that URL is now visible
  to anyone who can read the page. Fix it, or tell the user.

## 4. Hand it over

Give the user:

- the URL the command printed. It's the page itself when you published one file
  into a named space, otherwise the folder.
- the password, if it's locked. Any username works at the prompt.
- the expiry, if one is set.
- what's public and what's locked.

Passwords can always be looked up again, so never say one is unrecoverable:

```sh
dumpyard password /<space>/
```

Use `dumpyard list` only when the user asks for all their passwords, because it
prints every one of them.

Locked folders don't appear on the site's public index, so the URL is the only
way in.

## Later

```sh
dumpyard expire /<space>/ 3d     # set or change expiry; "never" clears it
dumpyard lock /<space>/          # add a password, or rotate one
dumpyard unlock /<space>/        # make it public
dumpyard remove /<space>/        # take it off the site
dumpyard prune                   # remove everything that has expired
```

Each of these deploys, so apply the same live check. Run `remove` and `prune`
only when the user asks; both take things offline immediately.

## Never

- Edit files in the site repo by hand. Use the CLI.
- Put a password in a file, a commit message or a published page. Giving it to
  the user in chat is fine.
- Publish credentials, private keys or other people's personal data, even
  behind a password.
