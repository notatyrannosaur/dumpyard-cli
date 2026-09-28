// Generated passwords: three random words, e.g. "orbit-cactus-mellow".
//
// 7,772 words -> ~12.9 bits each, ~38.8 bits for three. That's plenty against
// guessing over HTTP (Cloudflare caps a free site at 100k requests a day), and
// weak against someone holding the hash — which is why every hash is keyed
// with a per-site pepper that never enters the repo (see hash.js).
import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";

const WORDS = readFileSync(new URL("./wordlist.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((w) => w && !w.startsWith("#"));

export const WORD_COUNT = WORDS.length;
export const bitsFor = (n) => n * Math.log2(WORDS.length);

// randomInt is uniform (no modulo bias) and uses the OS CSPRNG.
export const passphrase = (n = 3) => Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)]).join("-");
