// One implementation, imported by both the gate and tools/lock.mjs, so the
// verifier and the generator can never drift apart.
//
// ponytail: a single fast SHA-256 is safe here only because lock.mjs generates
// 72-bit random passwords — there is nothing to brute-force. If humans start
// choosing their own, this needs PBKDF2, which needs a paid Cloudflare plan
// (free Pages Functions get 10 ms CPU per request; 100k iterations blow it).
export async function digest(salt, password) {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Equal-length hex digests, so this leaks neither length nor prefix.
export function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Longest matching prefix wins; unmatched paths are public. The trailing slash
// is what stops "/research/secret/" from also matching "/research/secretly/",
// and adding one to a bare "/plans" stops the 308 redirect confirming the
// directory exists.
export function lockFor(locks, pathname) {
  const path = pathname.endsWith("/") ? pathname : pathname + "/";
  const prefix = Object.keys(locks)
    .filter((p) => path.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? { prefix, ...locks[prefix] } : null;
}
