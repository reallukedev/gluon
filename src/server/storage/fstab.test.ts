import { describe, expect, it } from "vitest";
import { applyChanges, formatEntry, matchesVolume, parseFstab, parseVerify, sourceRef } from "./fstab";

describe("parseVerify", () => {
  it("passes a clean file", () => {
    expect(parseVerify("Success, no errors or warnings detected\n", "", 0).ok).toBe(true);
  });

  it("collects errors per target", () => {
    const out = "/mnt/media\n   [E] unreachable source: UUID=0000-example\n   [W] target is not a directory\n";
    const r = parseVerify(out, "\n0 parse errors, 1 error, 1 warning\n", 1);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ target: "/mnt/media", message: "unreachable source: UUID=0000-example" }]);
    expect(r.parseErrors).toBe(0);
  });

  it("counts parse errors from the summary, singular or plural", () => {
    const r = parseVerify("", "/tmp/fstab: parse error at line 3 -- ignored\n\n1 parse error, 0 errors, 0 warnings\n", 1);
    expect(r.parseErrors).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("never reads a findmnt that couldn't check as a pass", () => {
    const r = parseVerify("", "findmnt: unrecognized option '--verify'\nTry 'findmnt --help' for more information.\n", 1);
    expect(r.crashed).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe("fstab edits", () => {
  const text = "# /etc/fstab\nUUID=1111-aaaa / ext4 errors=remount-ro 0 1\n\n# Added by Gluon on 2026-01-01: disk\nUUID=2222-bbbb /mnt/My\\040Media ext4 defaults,nofail 0 2\n";

  it("keeps every line as written and unescapes names", () => {
    const p = parseFstab(text);
    expect(p.lines.map((l) => l.raw).join("\n") + "\n").toBe(text);
    expect(p.lines[4]!.entry!.file).toBe("/mnt/My Media");
    expect(formatEntry(p.lines[4]!.entry!)).toBe("UUID=2222-bbbb /mnt/My\\040Media ext4 defaults,nofail 0 2");
  });

  it("removes a line with the note Gluon left above it, and refuses a stale plan", () => {
    const p = parseFstab(text);
    const after = applyChanges(text, [{ kind: "remove", index: 4, expectRaw: p.lines[4]!.raw }]);
    expect(after).toBe("# /etc/fstab\nUUID=1111-aaaa / ext4 errors=remount-ro 0 1\n\n");
    expect(() => applyChanges(text, [{ kind: "remove", index: 4, expectRaw: "something else" }])).toThrow();
  });

  it("matches sources by UUID case-insensitively, labels exactly", () => {
    const e = parseFstab('UUID="ABCD-1234" /mnt/a ext4 defaults 0 0\nLABEL=Photos /mnt/b ext4 defaults 0 0\n').lines.map((l) => l.entry!);
    const v = { path: "/dev/sdb1", uuid: "abcd-1234", label: "photos", partUuid: null, partLabel: null };
    expect(sourceRef(e[0]!)).toEqual({ kind: "uuid", value: "ABCD-1234" });
    expect(matchesVolume(e[0]!, v)).toBe("uuid");
    expect(matchesVolume(e[1]!, v)).toBeNull();
  });
});
