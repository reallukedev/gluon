import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.stubEnv("GLUON_DATA", fs.mkdtempSync(path.join(os.tmpdir(), "gluon-smart-")));
const { parseSmart } = await import("./smart");

const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", n), "utf8")) as Record<string, unknown>;

describe("parseSmart", () => {
  it("reads a healthy SATA hard drive as ok", () => {
    const r = parseSmart(fixture("smart-sata-ok.json"), 0, "hdd", 1);
    expect(r.summary.state).toBe("ok");
    expect(r.summary.temperature).toBe(34);
    expect(r.summary.reallocated).toBe(0);
  });

  it("doesn't call a drive healthy when it gave no overall verdict", () => {
    const j = fixture("smart-sata-ok.json");
    delete j.smart_status;
    const r = parseSmart(j, 4, "hdd", 1);
    expect(r.summary.state).toBe("unknown");
    expect(r.summary.passed).toBeNull();
  });

  it("still reports problems it can see without a verdict", () => {
    const j = fixture("smart-sata-ok.json");
    delete j.smart_status;
    const table = (j.ata_smart_attributes as { table: { id: number; raw: { value: number; string: string } }[] }).table;
    table.find((a) => a.id === 197)!.raw = { value: 8, string: "8" };
    expect(parseSmart(j, 4, "hdd", 1).summary.state).toBe("warning");
  });

  it("says unavailable, not healthy, when SMART is turned off", () => {
    const j = fixture("smart-sata-ok.json");
    j.smart_support = { available: true, enabled: false };
    delete j.smart_status;
    expect(parseSmart(j, 4, "hdd", 1).summary.state).toBe("unavailable");
  });

  it("reads NVMe health, and its warning bits", () => {
    expect(parseSmart(fixture("smart-nvme.json"), 0, "nvme", 1).summary).toMatchObject({ state: "ok", wearPercent: 3, temperature: 41 });
    const hot = fixture("smart-nvme.json");
    (hot.nvme_smart_health_information_log as Record<string, number>).critical_warning = 0x02;
    expect(parseSmart(hot, 0, "nvme", 1).summary.state).toBe("warning");
    const ro = fixture("smart-nvme.json");
    (ro.nvme_smart_health_information_log as Record<string, number>).critical_warning = 0x08;
    expect(parseSmart(ro, 0, "nvme", 1).summary.state).toBe("failing");
  });

  it("recognises a sleeping drive without reading it", () => {
    const j = { smartctl: { messages: [{ string: "Device is in STANDBY mode, exit(2)", severity: "information" }] } };
    expect(parseSmart(j, 2, "hdd", 1).summary.state).toBe("asleep");
  });

  it("calls a drive that failed its own check failing", () => {
    const j = fixture("smart-sata-ok.json");
    j.smart_status = { passed: false };
    expect(parseSmart(j, 8, "hdd", 1).summary.state).toBe("failing");
  });
});
