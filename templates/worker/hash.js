// Shared by the gate (worker/index.js) and the CLI that writes locks.js, so the
// verifier and the generator can never drift apart.
//
// A single fast SHA-256 is safe here only because the CLI generates 72-bit
// random passwords, so there is nothing to brute-force. Hand-picked passwords
// are held to 12+ characters for the same reason. Real key stretching (PBKDF2
// at 100k+ iterations) does not fit the Workers free plan's 10 ms CPU budget.
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

// The form the gate matches against: percent-decoded, "." and ".." resolved,
// repeated slashes collapsed, lowercased, always ending in "/". So
// "/%70roject-xyz/", "//project-xyz/", "/open/../project-xyz/" and
// "/Project-XYZ/" all hit the lock for "/project-xyz/", without relying on the
// asset server to redirect them first. It only ever widens a match, so the
// worst case is asking for a password that wasn't needed.
export function normalize(pathname) {
  let p = String(pathname);
  // Decode until stable (bounded), so double-encoding can't sneak past.
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(p);
      if (d === p) break;
      p = d;
    } catch {
      break; // malformed escape: match what we have
    }
  }
  const out = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return ("/" + out.join("/") + (out.length ? "/" : "")).toLowerCase();
}

// Longest matching prefix wins; unmatched paths are public. The trailing slash
// is what stops "/research/secret/" from also matching "/research/secretly/",
// and adding one to a bare "/plans" means its redirect can't confirm it exists.
// Both the raw and the normalized path are checked; any match counts.
export function lockFor(locks, pathname) {
  const raw = pathname.endsWith("/") ? pathname : pathname + "/";
  const candidates = [raw, normalize(pathname)];
  const prefix = Object.keys(locks)
    .filter((p) => candidates.some((c) => c.startsWith(p) || c.startsWith(p.toLowerCase())))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? { prefix, ...locks[prefix] } : null;
}
