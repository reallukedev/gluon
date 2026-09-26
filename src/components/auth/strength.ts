/**
 * A quiet, local estimate of how guessable a password is. Advice only: Gluon accepts any password of
 * at least one character (the owner's choice). No network calls, no dictionary download.
 */

export interface Strength {
  /** 0 very easy to guess … 4 strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string | null;
}

const COMMON = [
  "password", "passw0rd", "123456", "12345678", "123456789", "qwerty", "qwertyuiop", "letmein", "welcome", "admin", "administrator",
  "iloveyou", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "master", "shadow", "abc123", "111111", "000000",
  "trustno1", "login", "changeme", "secret", "gluon", "server", "homeserver", "leech", "jellyfin", "umbrel", "casaos",
];

const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm", "01234567890"];

function hasSequence(pw: string): boolean {
  const l = pw.toLowerCase();
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 4 <= seq.length; i++) {
      const part = seq.slice(i, i + 4);
      if (l.includes(part) || l.includes([...part].reverse().join(""))) return true;
    }
  }
  return false;
}

export function passwordStrength(pw: string, context: string[] = []): Strength {
  if (!pw) return { score: 0, label: "", hint: null };
  const lower = pw.toLowerCase();
  const words = pw.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3);

  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z\d]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(Math.max(pool, 1));

  // Passphrases: four or more words are strong even in lowercase.
  if (words.length >= 3) bits = Math.max(bits, words.length * 11);

  const unique = new Set(lower).size;
  if (unique <= 2) bits = Math.min(bits, 8);
  else if (unique <= pw.length / 3) bits *= 0.6;
  if (hasSequence(pw)) bits -= 12;
  const common = COMMON.find((c) => lower.includes(c));
  if (common) bits -= common.length >= lower.length - 2 ? 60 : 18;
  const personal = context.map((c) => c.trim().toLowerCase()).find((c) => c.length >= 3 && lower.includes(c));
  if (personal) bits -= 20;

  const score: Strength["score"] = bits < 20 ? 0 : bits < 36 ? 1 : bits < 52 ? 2 : bits < 68 ? 3 : 4;
  const label = ["Very easy to guess", "Easy to guess", "Could be stronger", "Good", "Strong"][score]!;
  let hint: string | null = null;
  if (personal) hint = "Avoid your name or username.";
  else if (common) hint = "That's one of the first passwords anyone would try.";
  else if (score <= 2) hint = "A few random words is easy to remember and hard to guess.";
  return { score, label, hint };
}
