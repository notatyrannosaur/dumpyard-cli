# dumpyard

Private content repo. Pages, notes, PDFs and images, served by Cloudflare
Pages, with any folder able to sit behind its own password.

Managed with the [dumpyard CLI](https://github.com/notatyrannosaur/dumpyard-cli).
Don't hand-edit generated files — `public/llms.txt` lists which those are.

```sh
dumpyard publish report.html                    # public, at /report/
dumpyard publish ./project-xyz/ --set-password  # whole folder, one password
dumpyard lock /project-xyz/                     # lock something already here
dumpyard unlock /project-xyz/
dumpyard remove /project-xyz/                   # unpublish it
dumpyard list                                   # every lock, with its password
dumpyard password /project-xyz/                 # look one up
```

## Deploy

```sh
dumpyard deploy
```

That is the whole deploy — `wrangler` uploads `public/` and the Worker straight
to Cloudflare. No dashboard, no Git integration. `dumpyard publish` does it for
you at the end of every publish.

Only `public/` is uploaded. `worker/` stays local and served-from-nowhere, which
is why `worker/locks.js` cannot be fetched.

### The line you must not delete

`wrangler.jsonc` contains `"run_worker_first": true`. Cloudflare serves matching
static assets **before** the Worker by default, so without it the gate never runs
and every locked page is served to anyone who asks — silently, no error.

## How the passwords work

`worker/locks.js` holds a salted SHA-256 per path — never a password. Hashes
are not secrets, so there is no cap on how many folders you can lock and nothing
to provision in GitHub or Cloudflare. Longest matching prefix wins, so locking
`/project-xyz/` covers every page, note, PDF and image under it, and a single
page inside can still carry its own password on top.

Two properties worth keeping:

- **Locked things stay off public pages.** They are left out of any index less
  secret than they are, and a public note cannot link into a locked folder —
  the link renders as plain text instead of publishing a title and URL.
- **Nothing authenticated is cached.** Those responses go out `private, no-store`.

---

Structure and spirit borrowed from Arnav Gupta's
`championswimmer/sites.arnavg.in`. No code was copied; the access control,
markdown rendering and CLI are new.
