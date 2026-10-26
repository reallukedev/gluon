import type { VoiceChannel, VoiceUser } from "@/server/voice/types";

/** The channel tree laid out for drawing: depth-first, siblings by Mumble's position then name. Pure. */

export interface TreeRow {
  channel: VoiceChannel;
  depth: number;
  /** For each ancestor level (and this one), whether a sibling follows below: where to draw the guide lines. */
  rails: boolean[];
  last: boolean;
  /** People in this channel itself, and in it plus everything inside it. */
  here: VoiceUser[];
  total: number;
  descendants: number;
}

const order = (a: VoiceChannel, b: VoiceChannel) => a.position - b.position || a.name.localeCompare(b.name);

export function layoutTree(channels: VoiceChannel[], users: VoiceUser[]): TreeRow[] {
  const kids = new Map<number, VoiceChannel[]>();
  for (const c of channels) {
    if (c.id === 0 || c.parent < 0) continue;
    const list = kids.get(c.parent) ?? [];
    list.push(c);
    kids.set(c.parent, list);
  }
  for (const list of kids.values()) list.sort(order);
  const people = new Map<number, VoiceUser[]>();
  for (const u of users) people.set(u.channel, [...(people.get(u.channel) ?? []), u]);

  const out: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (c: VoiceChannel, depth: number, rails: boolean[], last: boolean): { total: number; count: number } => {
    seen.add(c.id);
    const row: TreeRow = { channel: c, depth, rails, last, here: people.get(c.id) ?? [], total: 0, descendants: 0 };
    out.push(row);
    let total = row.here.length;
    let count = 0;
    const children = (kids.get(c.id) ?? []).filter((k) => !seen.has(k.id));
    children.forEach((k, i) => {
      const isLast = i === children.length - 1;
      const r = walk(k, depth + 1, [...rails, !isLast], isLast);
      total += r.total;
      count += 1 + r.count;
    });
    row.total = total;
    row.descendants = count;
    return { total, count };
  };
  const root = channels.find((c) => c.id === 0);
  if (root) walk(root, 0, [], true);
  // Channels whose parent is missing (shouldn't happen) still get a row.
  for (const c of [...channels].sort(order)) if (!seen.has(c.id)) walk(c, 0, [], true);
  return out;
}

/** "Games › Raid night", without the top channel. */
export function channelPath(c: VoiceChannel, byId: Map<number, VoiceChannel>): string {
  if (c.id === 0) return c.name;
  const parts: string[] = [];
  let cur: VoiceChannel | undefined = c;
  for (let i = 0; cur && cur.id !== 0 && i < 32; i++) {
    parts.unshift(cur.name);
    cur = byId.get(cur.parent);
  }
  return parts.join(" › ");
}

/** The channel and everything inside it. */
export function subtree(id: number, channels: VoiceChannel[]): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of channels) if (!out.has(c.id) && out.has(c.parent)) {
      out.add(c.id);
      grew = true;
    }
  }
  return out;
}
