import "server-only";
import fs from "node:fs/promises";
import { registerCheck, registerRemedy } from "./engine";
import { raise, resolveMissing } from "../findings";
import { docker } from "../docker/client";
import { host } from "../host/exec";
import { hostPath } from "../host/paths";
import { AppError } from "../errors";

/**
 * Linux caps how many files and folders one user's programs may watch for changes
 * (fs.inotify.max_user_watches). When one program takes nearly all of them, every other program
 * that watches files quietly stops noticing changes: Jellyfin and Immich miss new media, sync
 * tools miss edits, development servers fail to start. Nothing crashes, so it's easy to miss.
 */

const LIMIT_FILE = "/proc/sys/fs/inotify/max_user_watches";
const CONF = "/etc/sysctl.d/60-gluon-file-watches.conf";
const KIND = "system.file_watches";

interface Holder {
  pid: number;
  uid: number;
  watches: number;
  program: string;
  container: string | null;
}

async function readNum(p: string): Promise<number | null> {
  const n = Number((await fs.readFile(p, "utf8").catch(() => "")).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Watches held per process (Gluon shares the host's process list). Reads only /proc. */
async function holders(): Promise<Holder[]> {
  const pids = (await fs.readdir("/proc").catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  const out: Holder[] = [];
  const one = async (pid: string) => {
    const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    let watches = 0;
    for (const fd of fds) {
      const link = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      if (link !== "anon_inode:inotify") continue;
      const info = await fs.readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8").catch(() => "");
      for (const line of info.split("\n")) if (line.startsWith("inotify ")) watches++;
    }
    if (!watches) return;
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
    const program = (await fs.readFile(`/proc/${pid}/comm`, "utf8").catch(() => "?")).trim();
    const cgroup = await fs.readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "");
    const container = /docker[-/]([0-9a-f]{64})/.exec(cgroup)?.[1] ?? null;
    out.push({ pid: Number(pid), uid, watches, program, container });
  };
  // A few at a time: fast enough for a few thousand processes, gentle on a busy box.
  for (let i = 0; i < pids.length; i += 32) await Promise.all(pids.slice(i, i + 32).map(one));
  return out;
}

async function containerName(id: string | null): Promise<string | null> {
  if (!id) return null;
  try {
    const info = await docker().getContainer(id).inspect();
    return info.Name.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");

registerCheck("file-watches", 10 * 60_000, async () => {
  const limit = await readNum(LIMIT_FILE);
  if (!limit) return;
  const list = await holders();
  const byUid = new Map<number, Holder[]>();
  for (const h of list) byUid.set(h.uid, [...(byUid.get(h.uid) ?? []), h]);
  const open = new Set<string>();
  for (const [uid, hs] of byUid) {
    const used = hs.reduce((a, h) => a + h.watches, 0);
    const share = used / limit;
    if (share < 0.85) continue;
    const top = [...hs].sort((a, b) => b.watches - a.watches)[0]!;
    const where = await containerName(top.container);
    const who = where ? `${where} (${top.program})` : top.program;
    const id = `${KIND}:${uid}`;
    open.add(id);
    const next = suggestedLimit(limit, used);
    raise({
      id,
      kind: KIND,
      severity: share >= 0.98 ? "fault" : "attention",
      subject: who,
      title: share >= 0.98 ? "Apps can't watch for new files any more" : "Apps are close to running out of file watches",
      cause:
        `${who} is watching ${fmt(top.watches)} files and folders, and everything together uses ${fmt(used)} of the ${fmt(limit)} Linux allows. ` +
        "Once they run out, apps like Jellyfin and Immich stop noticing new files until they rescan.",
      detail: { uid, used, limit, top: { pid: top.pid, program: top.program, container: where, watches: top.watches }, suggested: next },
      remedy: {
        action: "system.raiseFileWatches",
        label: `Raise the limit to ${fmt(next)}`,
        params: { limit: next },
        confirm: {
          title: `Raise the file-watch limit to ${fmt(next)}?`,
          consequences: [
            `Sets fs.inotify.max_user_watches to ${fmt(next)} now, and in ${CONF} so it stays after a restart.`,
            "Each watch in use takes about 1 KB of the kernel's memory; unused headroom costs nothing.",
            `Nothing restarts. ${who} keeps what it holds; other apps can watch files again.`,
          ],
        },
      },
    });
  }
  resolveMissing(KIND, open);
});

/** Double what's in use, rounded up to a power of two, between 524,288 and 8,388,608. */
function suggestedLimit(limit: number, used: number): number {
  let n = 524_288;
  while (n < used * 2 && n < 8_388_608) n *= 2;
  return Math.max(n, limit);
}

registerRemedy("system.raiseFileWatches", {
  recent: true,
  run: async ({ params }) => {
    const want = Number(params.limit);
    if (!Number.isInteger(want) || want < 8192 || want > 8_388_608) throw new AppError("bad_limit", "That limit is out of range.", 400);
    const current = (await readNum(LIMIT_FILE)) ?? 0;
    if (want <= current) return { message: `The limit is already ${fmt(current)}.` };
    await host("sysctl", ["-w", `fs.inotify.max_user_watches=${want}`], { timeoutMs: 10_000 });
    await fs.writeFile(
      hostPath(CONF),
      `# Written by Gluon: room for apps to watch files for changes (default limits run out on busy servers).\nfs.inotify.max_user_watches = ${want}\n`,
      { mode: 0o644 },
    );
    return { message: `Apps can watch up to ${fmt(want)} files now, and after restarts too.` };
  },
});
