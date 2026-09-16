# dumpyard

Private content repo. Pages, notes, PDFs and images, served by Cloudflare
Pages, with any folder able to sit behind its own password.

Managed with the [dumpyard CLI](https://github.com/notatyrannosaur/dumpyard-cli).
Don't hand-edit generated files — `llms.txt` lists which those are.

```sh
dumpyard publish report.html                    # public, at /report/
dumpyard publish ./project-xyz/ --set-password  # whole folder, one password
dumpyard lock /project-xyz/                     # lock something already here
dumpyard unlock /project-xyz/
dumpyard list
```

## Deploy (one-time)

1. Cloudflare dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git
2. Framework preset **None**, build command **empty**, output directory `/`
3. Custom domain, if you have one: Settings -> Custom domains

Every push redeploys. Cloudflare runs no build; the CLI builds locally and
commits the output.

## How the passwords work

`functions/locks.js` holds a salted SHA-256 per path — never a password. Hashes
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
