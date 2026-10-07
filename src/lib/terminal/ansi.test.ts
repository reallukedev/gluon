import { describe, expect, it } from "vitest";
import { AnsiScreen, styleOf } from "./ansi";

const screen = (...chunks: string[]) => {
  const s = new AnsiScreen(24);
  for (const c of chunks) s.write(c);
  return s;
};

describe("AnsiScreen", () => {
  it("never shows escape codes, even when they're split across chunks", () => {
    const s = screen("plain \x1b[3", "1mred\x1b[0m done\x1b]0;title\x07\r\n");
    expect(s.text()).toBe("plain red done");
    const runs = s.runs(0);
    expect(runs.map((r) => r.text)).toEqual(["plain ", "red", " done"]);
    expect(styleOf(runs[1]!.s).fg).toBe(1);
    expect(styleOf(runs[2]!.s).fg).toBeNull();
  });

  it("drops unknown sequences instead of printing them", () => {
    expect(screen("a\x1b[?25lb\x1b[6nc\x1b(Bd").text()).toBe("abcd");
  });

  it("overwrites a line on carriage return, the way progress bars draw", () => {
    expect(screen("  10%\r  55%\r 100%\r\ndone\r\n").text()).toBe(" 100%\ndone");
  });

  it("redraws lines above with cursor-up and erase-line (docker pull)", () => {
    const s = screen("a: Waiting\r\nb: Waiting\r\n", "\x1b[2A\x1b[2Ka: Done\r\n\x1b[2Kb: Pulling\r\n");
    expect(s.text()).toBe("a: Done\nb: Pulling");
  });

  it("starts over on clear", () => {
    expect(screen("old\r\n\x1b[H\x1b[2Jnew").text()).toBe("new");
  });

  it("maps 256 and true colours onto the nearest of the 16 slots", () => {
    const s = screen("\x1b[38;5;196mA\x1b[38;2;0;200;0mB\x1b[48;5;21mC");
    const [a, b, c] = s.runs(0);
    expect(styleOf(a!.s).fg).toBe(9);
    expect(styleOf(b!.s).fg).toBe(2);
    expect(styleOf(c!.s).bg).toBe(4);
  });

  it("keeps bold and resets it", () => {
    const [b, n] = screen("\x1b[1mB\x1b[22mn").runs(0);
    expect(styleOf(b!.s).bold).toBe(true);
    expect(styleOf(n!.s).bold).toBe(false);
  });

  it("notices a full-screen program switching to the alternate screen", () => {
    const s = screen("\x1b[?1049h\x1b[H");
    expect(s.altScreen).toBe(true);
    expect(screen("\x1b[?25h").altScreen).toBe(false);
  });

  it("expands tabs and backspaces", () => {
    expect(screen("a\tb\r\nab\bc").text()).toBe("a       b\nac");
  });
});
