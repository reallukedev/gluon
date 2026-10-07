import { describe, expect, it } from "vitest";
import { MarkerFilter } from "./markers";

const N = "n0nce";

describe("MarkerFilter", () => {
  it("lets a program's look-alike marker through as output (wrong nonce)", () => {
    const f = new MarkerFilter(N);
    const fake = "\x1b]7770;guess;0;/root\x07";
    expect(f.push(`x${fake}y`)).toEqual({ text: `x${fake}y`, markers: [] });
  });

  it("doesn't hold output back forever when a marker never finishes", () => {
    const f = new MarkerFilter(N);
    const r = f.push(`a\x1b]7770;${N};0;` + "z".repeat(9000));
    expect(r.text.length).toBeGreaterThan(9000);
    expect(r.markers).toEqual([]);
  });

  it("takes out the pid and done markers", () => {
    const f = new MarkerFilter(N);
    const r = f.push(`\x1b]7771;${N};4242\x07hello\r\n\x1b]7770;${N};3;/var/lib/my;dir\x07`);
    expect(r.text).toBe("hello\r\n");
    expect(r.markers).toEqual([
      { kind: "pid", pid: 4242 },
      { kind: "done", code: 3, cwd: "/var/lib/my;dir" },
    ]);
  });

  it("finds a marker split across chunks, at any byte", () => {
    const whole = `out\x1b]7770;${N};0;/etc\x07`;
    for (let cut = 1; cut < whole.length; cut++) {
      const f = new MarkerFilter(N);
      const a = f.push(whole.slice(0, cut));
      const b = f.push(whole.slice(cut));
      expect(a.text + b.text + f.flush()).toBe("out");
      expect([...a.markers, ...b.markers]).toEqual([{ kind: "done", code: 0, cwd: "/etc" }]);
    }
  });

  it("returns a held-back tail on flush", () => {
    const f = new MarkerFilter(N);
    expect(f.push("abc\x1b]7").text).toBe("abc");
    expect(f.flush()).toBe("\x1b]7");
  });
});
