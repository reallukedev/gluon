import { describe, expect, it } from "vitest";
import { unescapeMount } from "./sampler";

describe("unescapeMount", () => {
  it("decodes the octal escapes /proc/mounts uses", () => {
    expect(unescapeMount("/srv/My\\040Films")).toBe("/srv/My Films");
    expect(unescapeMount("/mnt/tab\\011and\\134slash")).toBe("/mnt/tab\tand\\slash");
    expect(unescapeMount("/plain")).toBe("/plain");
  });
});
