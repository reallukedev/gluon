/** Folder arithmetic for the target's paths (always POSIX, whatever the browser runs on). */

export function normalize(path: string): string {
  const abs = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return abs ? `/${joined}` : joined || ".";
}

/**
 * The absolute folder a typed folder means, from the working folder: "" is the working folder,
 * "~/" is home, "../x/" goes up. Null when it can't be known here (`~luke/`, `$HOME/`).
 */
export function resolveDir(cwd: string, home: string | null, typed: string): string | null {
  if (/[$`]/.test(typed)) return null;
  if (typed === "~" || typed.startsWith("~/")) {
    if (!home) return null;
    return normalize(`${home}/${typed.slice(1)}`);
  }
  if (typed.startsWith("~")) return null;
  if (typed.startsWith("/")) return normalize(typed);
  return normalize(`${cwd}/${typed}`);
}

/** The working folder written short for a prompt: home becomes ~. */
export function shortPath(cwd: string, home: string | null): string {
  if (home && home !== "/" && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}
