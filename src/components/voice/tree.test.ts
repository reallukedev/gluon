import { describe, expect, it } from "vitest";
import type { VoiceChannel, VoiceUser } from "@/server/voice/types";
import { channelPath, layoutTree, subtree } from "./tree";

const ch = (id: number, name: string, parent: number, position = 0): VoiceChannel => ({ id, name, parent, position, description: "", temporary: false, links: [] });
const user = (session: number, channel: number) => ({ session, channel, name: `u${session}` }) as VoiceUser;

const channels = [ch(0, "Root", -1), ch(3, "Raid", 1), ch(1, "Games", 0, 1), ch(2, "AFK", 0, 2), ch(4, "Chill", 0, 1)];

describe("layoutTree", () => {
  const rows = layoutTree(channels, [user(1, 3), user(2, 3), user(3, 0)]);

  it("orders depth-first by position, then name", () => {
    expect(rows.map((r) => `${"-".repeat(r.depth)}${r.channel.name}`)).toEqual(["Root", "-Chill", "-Games", "--Raid", "-AFK"]);
  });

  it("counts people in each channel and everything inside it", () => {
    const by = Object.fromEntries(rows.map((r) => [r.channel.name, [r.here.length, r.total, r.descendants]]));
    expect(by).toEqual({ Root: [1, 3, 4], Chill: [0, 0, 0], Games: [0, 2, 1], Raid: [2, 2, 0], AFK: [0, 0, 0] });
  });

  it("knows where guide lines continue below a row", () => {
    const raid = rows.find((r) => r.channel.name === "Raid")!;
    // Games has a sibling below it (AFK), so its rail runs past Raid; Raid is its parent's last child.
    expect(raid.rails).toEqual([true, false]);
    expect(rows.find((r) => r.channel.name === "AFK")!.last).toBe(true);
  });
});

describe("channelPath and subtree", () => {
  const byId = new Map(channels.map((c) => [c.id, c]));
  it("names a channel by its path below the top", () => {
    expect(channelPath(byId.get(3)!, byId)).toBe("Games › Raid");
  });
  it("finds a channel and everything inside it", () => {
    expect([...subtree(1, channels)].sort()).toEqual([1, 3]);
  });
});
