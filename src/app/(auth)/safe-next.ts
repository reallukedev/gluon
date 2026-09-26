/**
 * Where to go after signing in. Only paths on this server: "/files?x=1" yes; "//evil.com",
 * "/\evil.com", "https://evil.com", control characters and anything that parses to another origin no.
 */
export function safeNext(raw: string | string[] | undefined, fallback = "/start"): string {
  const next = Array.isArray(raw) ? raw[0] : raw;
  if (!next || next.length > 2000) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const base = "http://gluon.invalid";
    const u = new URL(next, base);
    if (u.origin !== base) return fallback;
    if (u.pathname.startsWith("/login") || u.pathname.startsWith("/api/")) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
