import { describe, expect, test } from "vitest";
import { checkSitePath } from "./sites-types";

describe("paths inside a site", () => {
  test.each([
    ["index.html", "index.html"],
    ["/about/index.html", "about/index.html"],
    ["blog/2026/first post.html", "blog/2026/first post.html"],
    [".well-known/security.txt", ".well-known/security.txt"],
    ["fotos/café.jpg", "fotos/café.jpg"],
  ])("accepts %s", (raw, clean) => {
    expect(checkSitePath(raw)).toEqual({ ok: true, path: clean });
  });

  test.each([
    ["climbs out with ..", "../secret"],
    ["climbs out in the middle", "a/../../secret"],
    ["uses a backslash (a Windows path that could climb)", "a\\..\\b"],
    ["is a hidden file", ".env"],
    ["hides a folder", "assets/.git/config"],
    ["puts .well-known anywhere but the top", "blog/.well-known/x"],
    ["has a NUL byte", "a\0b.html"],
    ["has a control character", "a\nb.html"],
    ["has characters URLs mangle", "what?.html"],
    ["has a percent sign", "100%.html"],
    ["has two slashes", "a//b"],
    ["ends with a dot", "readme."],
    ["is empty", "/"],
    ["goes too deep", Array.from({ length: 13 }, () => "d").join("/")],
  ])("refuses a path that %s", (_, raw) => {
    expect(checkSitePath(raw).ok).toBe(false);
  });
});
