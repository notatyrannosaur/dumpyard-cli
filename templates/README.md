# dumpyard site

Pages, notes, PDFs and images served from a Cloudflare Worker. Any folder can
have its own password. Managed with the
[dumpyard CLI](https://github.com/notatyrannosaur/dumpyard-cli); don't edit the
generated files by hand.

```sh
dumpyard publish report.html                    # public, at /report/
dumpyard publish ./project-xyz/ --set-password  # whole folder, one password
dumpyard lock /project-xyz/                     # lock, or rotate a password
dumpyard unlock /project-xyz/
dumpyard remove /project-xyz/                   # take it off the site
dumpyard list                                   # every lock, with its password
dumpyard password /project-xyz/                 # look one up
dumpyard expire /project-xyz/ 7d                # the link dies in a week
dumpyard prune                                  # delete what has expired
dumpyard status                                 # what's here, no passwords
```

Each command commits, pushes and deploys, and ends with `Deployed. Live now.`
or `NOT DEPLOYED`.

## Layout

```
wrangler.jsonc   Cloudflare config. "run_worker_first": true is load-bearing.
worker/          the password gate; never served
  locks.js       salted hashes, generated; never passwords
public/          the only thing Cloudflare serves
llms.txt         instructions for agents working in this repo
```

## Rules

- **Never delete `"run_worker_first": true`** from `wrangler.jsonc`. Without it,
  Cloudflare serves files before the gate runs, and every locked page is public
  with no error.
- **Keep this repo private** if you push it anywhere. The passwords protect the
  deployed site, not these sources.
- **Your own files win.** If you write `index.html` or `foo.html` yourself,
  dumpyard never overwrites it. It only rewrites files it generated.
- **Passwords are not stored here.** They live in `~/.config/dumpyard/` on the
  machine that created them.
