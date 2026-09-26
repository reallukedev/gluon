import "server-only";
import { findUmbrel, umbrelVersion } from "../platform/umbrel";
import fs from "node:fs";
import os from "node:os";
import { host } from "../host/exec";
import { hostExists, readHostFileOr } from "../host/paths";
import { memInfo, uptimeSeconds } from "../host/proc";
import { latestHost, sensors } from "../metrics/sampler";
import { docker } from "../docker/client";
import type { SystemOverview } from "@/lib/system-types";
import { rebootStatus } from "./apt";
import { timeStatus } from "./time";

/** Values that firmware vendors leave in DMI fields instead of real data. */
const PLACEHOLDER =
  /^(to be filled by o\.?e\.?m\.?|default string|system product name|system manufacturer|not specified|not applicable|none|o\.?e\.?m\.?|x\.x|0123456789|base board product name|type1productconfigid|n\/a)$/i;

function dmi(field: string): string | null {
  const v = readHostFileOr(`/sys/class/dmi/id/${field}`, "").trim();
  return v && !PLACEHOLDER.test(v) ? v : null;
}

const CHASSIS: Record<string, string> = {
  "3": "desktop",
  "4": "desktop",
  "5": "desktop",
  "6": "desktop",
  "7": "tower",
  "8": "laptop",
  "9": "laptop",
  "10": "laptop",
  "13": "all-in-one",
  "14": "laptop",
  "17": "server",
  "23": "server",
  "24": "server",
  "28": "server",
  "30": "tablet",
  "31": "laptop",
  "32": "laptop",
  "35": "mini PC",
  "36": "stick PC",
};

function osRelease(): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readHostFileOr("/etc/os-release", "") || readHostFileOr("/usr/lib/os-release", "");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

function cpuInfo(): SystemOverview["cpu"] {
  let text = "";
  try {
    text = fs.readFileSync("/proc/cpuinfo", "utf8"); // kernel-wide, same inside the container
  } catch {
    /* unreadable: fall back to os.cpus() below */
  }
  const blocks = text.split(/\n\s*\n/).filter((b) => /^processor\s*:/m.test(b));
  const field = (b: string, k: string) => b.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
  const first = blocks[0] ?? text;
  const model = field(first, "model name") ?? field(text, "Model") ?? field(text, "Hardware") ?? field(first, "cpu model");
  const sockets = new Set(blocks.map((b) => field(b, "physical id")).filter(Boolean)).size || null;
  const coresPerSocket = Number(field(first, "cpu cores")) || null;
  const mhz = blocks.map((b) => Number(field(b, "cpu MHz"))).filter((n) => n > 0);
  return {
    model: model?.replace(/\s+/g, " ") ?? null,
    cores: coresPerSocket ? coresPerSocket * (sockets ?? 1) : null,
    threads: blocks.length || os.cpus().length,
    sockets,
    mhz: mhz.length ? Math.round(mhz.reduce((a, b) => a + b, 0) / mhz.length) : null,
  };
}

function bootedAt(): number {
  const btime = readHostFileOr("/proc/stat", "").match(/^btime (\d+)/m)?.[1];
  return btime ? Number(btime) * 1000 : Date.now() - uptimeSeconds() * 1000;
}

interface Slow {
  at: number;
  hostname: string;
  prettyHostname: string | null;
  chassis: string | null;
  virtualization: string | null;
  casaos: string | null;
  umbrel: string | null;
  docker: string | null;
  systemd: string | null;
}

type G = typeof globalThis & { __gluonSysSlow?: Slow };
const g = globalThis as G;

/** Things that come from running programs; they rarely change, so cache them for 5 minutes. */
async function slowFacts(): Promise<Slow> {
  const c = g.__gluonSysSlow;
  if (c && Date.now() - c.at < 5 * 60_000) return c;
  const [hn, virt, casa, dock, sd, umb] = await Promise.all([
    host("hostnamectl", ["--json=short"], { timeoutMs: 8000 })
      .then(
        (r) =>
          JSON.parse(r.stdout) as {
            Hostname?: string;
            StaticHostname?: string;
            PrettyHostname?: string | null;
            Chassis?: string | null;
          },
      )
      .catch(() => null),
    host("systemd-detect-virt", [], { timeoutMs: 5000, okCodes: [1] })
      .then((r) => r.stdout.trim() || null)
      .catch(() => null),
    hostExists("/usr/bin/casaos")
      ? host("casaos", ["-v"], { timeoutMs: 5000 })
          .then((r) => r.stdout.trim().match(/v?(\d+\.\d+(?:\.\d+)?\S*)/)?.[1] ?? null)
          .catch(() => null)
      : Promise.resolve(null),
    docker()
      .version()
      .then((v) => v.Version ?? null)
      .catch(() => null),
    host("systemctl", ["--version"], { timeoutMs: 5000 })
      .then(
        (r) =>
          r.stdout
            .match(/^systemd (\d+)(?: \(([^)]+)\))?/)
            ?.slice(1)
            .filter(Boolean)
            .at(-1) ?? null,
      )
      .catch(() => null),
    findUmbrel()
      .then((ep) => (ep ? umbrelVersion() : null))
      .catch(() => null),
  ]);
  const hostname = hn?.Hostname || hn?.StaticHostname || readHostFileOr("/etc/hostname", "").trim() || os.hostname();
  const slow: Slow = {
    at: Date.now(),
    hostname,
    prettyHostname: hn?.PrettyHostname || null,
    chassis: hn?.Chassis || null,
    virtualization: virt,
    casaos: casa,
    umbrel: umb,
    docker: dock,
    systemd: sd?.replace(/-.*$/, "") ?? null,
  };
  g.__gluonSysSlow = slow;
  return slow;
}

export function invalidateOverview() {
  g.__gluonSysSlow = undefined;
}

export async function systemOverview(): Promise<SystemOverview> {
  const [slow, time] = await Promise.all([slowFacts(), timeStatus()]);
  const rel = osRelease();
  const mem = memInfo();
  const up = uptimeSeconds();
  const chassisType = dmi("chassis_type");
  const h = latestHost();
  return {
    hostname: slow.hostname,
    prettyHostname: slow.prettyHostname,
    os: {
      prettyName: rel.PRETTY_NAME ?? rel.NAME ?? "Linux",
      name: rel.NAME ?? null,
      version: rel.VERSION_ID ?? null,
      versionFull: rel.DEBIAN_VERSION_FULL || readHostFileOr("/etc/debian_version", "").trim() || rel.VERSION || null,
      codename: rel.VERSION_CODENAME ?? null,
      id: rel.ID ?? null,
    },
    kernel: { release: os.release(), version: os.version?.() ?? null },
    architecture: os.machine?.() ?? os.arch(),
    cpu: cpuInfo(),
    memory: {
      total: mem.total,
      available: mem.available,
      used: mem.used,
      swapTotal: mem.swapTotal,
      swapUsed: mem.swapUsed,
    },
    hardware: {
      vendor: dmi("sys_vendor"),
      product: dmi("product_name"),
      boardVendor: dmi("board_vendor"),
      board: dmi("board_name"),
      biosVersion: dmi("bios_version"),
      biosDate: dmi("bios_date"),
      chassis: slow.chassis ?? (chassisType ? (CHASSIS[chassisType] ?? null) : null),
    },
    bootedAt: bootedAt(),
    uptimeSeconds: up,
    time,
    virtualization: slow.virtualization,
    temperatures: sensors().map((s) => ({
      chip: s.chip,
      label: s.label,
      celsius: s.celsius,
      high: s.high ?? null,
      crit: s.crit ?? null,
    })),
    cpuTemperature: h?.temp ?? null,
    casaos: slow.casaos,
    umbrel: slow.umbrel,
    docker: slow.docker,
    systemd: slow.systemd,
    reboot: rebootStatus(),
  };
}
