import { describe, expect, it } from "vitest";
import { devNumber } from "./mounts";

describe("devNumber", () => {
  it("matches glibc makedev for small and large numbers", () => {
    expect(devNumber("8:17")).toBe(8 * 256 + 17);
    expect(devNumber("259:1")).toBe(0x10301);
    // Minor above 255 spills into bits 20 and up; major above 4095 into bits 44 and up.
    expect(devNumber("8:256")).toBe(8 * 256 + 2 ** 20);
    expect(devNumber("4096:0")).toBe(2 ** 44);
  });
});
