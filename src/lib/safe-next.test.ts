import { describe, expect, it } from "vitest";
import { loginHref, safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps paths on this server, with their query", () => {
    expect(safeNext("/settings/people")).toBe("/settings/people");
    expect(safeNext("/files?path=%2Fmedia&view=grid")).toBe("/files?path=%2Fmedia&view=grid");
  });

  it("refuses anything that could lead off-site", () => {
    for (const bad of ["https://example.com/", "//example.com/", "/\\example.com", "example.com", "/a\nb", "javascript:alert(1)"]) {
      expect(safeNext(bad), bad).toBe("/start");
    }
  });

  it("never returns to the sign-in page or the API", () => {
    expect(safeNext("/login?next=/x")).toBe("/start");
    expect(safeNext("/api/people")).toBe("/start");
  });
});

describe("loginHref", () => {
  it("carries the page that was asked for", () => {
    expect(loginHref("/settings/people")).toBe("/login?next=%2Fsettings%2Fpeople");
    expect(loginHref("/files?path=%2Fmedia")).toBe("/login?next=%2Ffiles%3Fpath%3D%252Fmedia");
  });

  it("leaves it out when there is nothing worth returning to", () => {
    expect(loginHref(null)).toBe("/login");
    expect(loginHref("/")).toBe("/login");
    expect(loginHref("/login")).toBe("/login");
  });

  it("drops a path that isn't on this server", () => {
    expect(loginHref("//example.com/")).toBe("/login");
    expect(loginHref("https://example.com/settings")).toBe("/login");
  });
});
