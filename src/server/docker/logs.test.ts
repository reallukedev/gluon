import { describe, expect, it } from "vitest";
import { demuxer } from "./logs";

const frame = (stream: 1 | 2, data: Buffer) => {
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
};

describe("Docker log stream", () => {
  it("splits stdout and stderr frames, even when a frame arrives in pieces", () => {
    const lines: string[] = [];
    const d = demuxer(false, (s, raw) => lines.push(`${s}:${raw}`));
    const all = Buffer.concat([frame(1, Buffer.from("one\ntw")), frame(2, Buffer.from("oops\r\n")), frame(1, Buffer.from("o\n"))]);
    for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
    d.flush();
    expect(lines).toEqual(["out:one", "err:oops", "out:two"]);
  });

  it("keeps a character that's split across frames or chunks whole", () => {
    const text = Buffer.from("café ✓\n");
    const lines: string[] = [];
    const d = demuxer(false, (_s, raw) => lines.push(raw));
    d.push(frame(1, text.subarray(0, 4)));
    d.push(frame(1, text.subarray(4, 8)));
    d.push(frame(1, text.subarray(8)));
    expect(lines).toEqual(["café ✓"]);

    const tty: string[] = [];
    const t = demuxer(true, (_s, raw) => tty.push(raw));
    for (let i = 0; i < text.length; i++) t.push(text.subarray(i, i + 1));
    t.push(Buffer.from("last line, no newline"));
    t.flush();
    expect(tty).toEqual(["café ✓", "last line, no newline"]);
  });
});
