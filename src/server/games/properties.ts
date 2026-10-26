/**
 * Java .properties, the format of a Minecraft server's server.properties: `key=value` lines, `#`
 * comments, backslash escapes (the MOTD's § is often written §) and continued lines.
 */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/^[ \t\f]+/, "");
    if (!line || line[0] === "#" || line[0] === "!") continue;
    // An odd number of trailing backslashes continues the line.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i]!.replace(/^[ \t\f]+/, "");
    let k = 0;
    for (; k < line.length; k++) {
      const c = line[k]!;
      if (c === "\\") k++;
      else if (c === "=" || c === ":" || c === " " || c === "\t" || c === "\f") break;
    }
    const key = line.slice(0, k);
    let rest = line.slice(k).replace(/^[ \t\f]*/, "");
    if (rest[0] === "=" || rest[0] === ":") rest = rest.slice(1).replace(/^[ \t\f]*/, "");
    out.set(unescape(key), unescape(rest));
  }
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
    if (e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e === "t" ? "\t" : e === "n" ? "\n" : e === "r" ? "\r" : e === "f" ? "\f" : e;
  });
}
