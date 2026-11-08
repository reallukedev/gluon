import { describe, expect, it } from "vitest";
import { isRemoteFs, parseMountinfo } from "./mounts";

describe("parseMountinfo", () => {
  it("reads a filesystem the kernel turned read-only after errors as read-only", () => {
    const text = [
      "29 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw,errors=remount-ro",
      "40 29 8:17 / /mnt/media rw,relatime shared:20 - ext4 /dev/sdb1 ro,errors=remount-ro",
      "41 29 8:33 / /mnt/My\\040Drive ro,relatime - exfat /dev/sdc1 rw,uid=1000",
    ].join("\n");
    const m = parseMountinfo(text);
    expect(m.map((x) => [x.mount, x.readOnly])).toEqual([
      ["/", false],
      ["/mnt/media", true],
      ["/mnt/My Drive", true],
    ]);
  });
});

describe("isRemoteFs", () => {
  it("treats network shares and FUSE as able to hang, local NTFS (fuseblk) as not", () => {
    for (const t of ["nfs", "nfs4", "cifs", "fuse.sshfs", "fuse.mergerfs"]) expect(isRemoteFs(t)).toBe(true);
    for (const t of ["ext4", "fuseblk", "btrfs", "exfat"]) expect(isRemoteFs(t)).toBe(false);
  });
});
