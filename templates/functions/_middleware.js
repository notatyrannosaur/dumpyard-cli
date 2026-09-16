// Cloudflare Pages Function. Runs on every request to this site.
// Password-gates the paths listed in locks.js; everything else passes through.
import LOCKS from "./locks.js";
import { digest, sameDigest, lockFor } from "./hash.js";

export async function onRequest({ request, env, next }) {
  const lock = lockFor(LOCKS, new URL(request.url).pathname);
  if (!lock) return next();

  if (!(await authorized(request, lock))) {
    return new Response("Unauthorized\n", {
      status: 401,
      headers: {
        // realm = prefix, so the browser keeps one saved password per lock
        // instead of retrying the wrong one across sections.
        "WWW-Authenticate": `Basic realm="${lock.prefix}", charset="UTF-8"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const res = await next();
  const out = new Response(res.body, res);
  // Never let a shared cache hold a page that needed a password.
  out.headers.set("Cache-Control", "private, no-store");
  return out;
}

// Any username is accepted; only the password is checked.
export async function authorized(request, lock) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let supplied;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    supplied = new TextDecoder().decode(bytes).split(":").slice(1).join(":");
  } catch {
    return false; // malformed base64
  }
  return sameDigest(await digest(lock.salt, supplied), lock.hash);
}
