import { describe, expect, it } from "vitest";
import { explainAptError } from "./apt";

describe("explainAptError", () => {
  it("blames a full disk, not the 404 apt hits when it falls back to an uncompressed list", () => {
    // apt-get update on Debian 13 with /var full (2026-10-25).
    const out = `Get:5 http://security.debian.org/debian-security trixie-security/main amd64 Packages [270 kB]
Err:5 http://security.debian.org/debian-security trixie-security/main amd64 Packages
  Write error - write (28: No space left on device)
Ign:5 http://security.debian.org/debian-security trixie-security/main amd64 Packages
Err:5 http://security.debian.org/debian-security trixie-security/main amd64 Packages
  404  Not Found [IP: 2a04:4e42:d::644 80]
E: Failed to fetch http://security.debian.org/debian-security/dists/trixie-security/main/binary-amd64/Packages  404  Not Found [IP: 2a04:4e42:d::644 80]
E: Some index files failed to download. They have been ignored, or old ones used instead.`;
    expect(explainAptError(out)).toMatch(/^The disk that holds \/var is full/);
    expect(explainAptError(out.replace(/.*No space left on device.*\n/, ""))).toMatch(/^A package source no longer exists \(http:\/\/security\.debian\.org/);
  });
});
