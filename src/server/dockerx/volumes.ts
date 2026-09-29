import "server-only";
import { docker } from "../docker/client";
import { AppError } from "../errors";
import { formatBytes } from "@/lib/format";
import { appRef, dial, dockerError, snapshot, usersText, type Snapshot } from "./core";
import { afterChange } from "./images";
import type { DockerVolume, Guard, VolumeMount, VolumesResponse, VolumeSizes } from "@/lib/docker-types";

interface RawVolume {
  Name: string;
  Driver: string;
  Mountpoint?: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
  Scope?: string;
}

export const isAnonymous = (v: { Name: string; Labels?: Record<string, string> | null }) => v.Labels?.["com.docker.volume.anonymous"] !== undefined || /^[0-9a-f]{64}$/.test(v.Name);

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;

export async function listVolumes(): Promise<VolumesResponse> {
  const snap = await snapshot();
  let raw: { Volumes?: RawVolume[] | null };
  try {
    raw = await dial<{ Volumes?: RawVolume[] | null }>({ path: "/volumes", method: "GET" });
  } catch (e) {
    throw dockerError(e, "Couldn't list volumes");
  }
  return { volumes: buildVolumes(raw.Volumes ?? [], snap), platform: snap.platform };
}

function buildVolumes(raw: RawVolume[], snap: Snapshot): DockerVolume[] {
  const mounts = new Map<string, VolumeMount[]>();
  for (const c of snap.containers) {
    const ref = snap.refs.get(c.Id);
    if (!ref) continue;
    for (const m of c.Mounts ?? []) {
      if (m.Type !== "volume" || !m.Name) continue;
      mounts.set(m.Name, [...(mounts.get(m.Name) ?? []), { ...ref, destination: m.Destination, rw: m.RW }]);
    }
  }
  return raw
    .map((v): DockerVolume => {
      const labels = v.Labels ?? {};
      const containers = (mounts.get(v.Name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      const project = labels["com.docker.compose.project"] ?? null;
      const byProject = project ? (snap.appById.get(project) ?? snap.apps.find((a) => a.id === project || a.id.startsWith(`${project}.`))) : undefined;
      const app = containers.find((c) => c.app)?.app ?? (byProject ? appRef(byProject) : null);
      const created = v.CreatedAt ? Date.parse(v.CreatedAt) : NaN;
      const vol: DockerVolume = {
        name: v.Name,
        anonymous: isAnonymous(v),
        driver: v.Driver,
        mountpoint: v.Mountpoint || null,
        created: Number.isFinite(created) ? created : null,
        project,
        composeName: labels["com.docker.compose.volume"] ?? null,
        containers,
        app,
        guard: null,
        labels,
        options: v.Options ?? {},
      };
      vol.guard = guardFor(vol);
      return vol;
    })
    .sort((a, b) => Number(a.anonymous) - Number(b.anonymous) || a.name.localeCompare(b.name));
}

function guardFor(v: DockerVolume): Guard | null {
  if (v.containers.some((c) => c.self)) return { level: "block", who: "gluon", message: "Gluon itself uses this volume." };
  if (v.containers.some((c) => c.platform === "umbrel")) return { level: "block", who: "umbrel", message: "Umbrel keeps its own data in this volume." };
  if (/^(leech-gluon|gluon|tend)(-dev)?[_-](data|next|node-modules)$/.test(v.name) || (v.project && /^(leech-gluon|gluon|tend)(-dev)?$/.test(v.project))) {
    return { level: "warn", who: "gluon", message: "Looks like a Gluon install's data (settings, accounts, history)." };
  }
  return null;
}

// ---------------------------------------------------------------- sizes (slow)

let sizeCache: { at: number; value: Promise<VolumeSizes> } | null = null;

/**
 * Docker measures volumes by walking every file, which can take a while on a big media library.
 * Asked for separately (and cached a minute) so the list never waits on it.
 */
export function volumeSizes(fresh = false): Promise<VolumeSizes> {
  if (!fresh && sizeCache && Date.now() - sizeCache.at < 60_000) return sizeCache.value;
  const value = dial<{ Volumes?: { Name: string; UsageData?: { Size?: number; RefCount?: number } | null }[] | null }>({
    path: "/system/df",
    method: "GET",
    query: { type: "volume" },
    signal: AbortSignal.timeout(5 * 60_000),
  })
    .then((r) => {
      const sizes: Record<string, number | null> = {};
      for (const v of r.Volumes ?? []) {
        const n = v.UsageData?.Size;
        sizes[v.Name] = typeof n === "number" && n >= 0 ? n : null;
      }
      return { at: Date.now(), sizes };
    })
    .catch((e) => {
      sizeCache = null;
      throw dockerError(e, "Couldn't measure volumes");
    });
  sizeCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- create / remove

export async function createVolume(name: string, labels: Record<string, string> = {}): Promise<{ message: string }> {
  const n = name.trim();
  if (!NAME_RE.test(n)) throw new AppError("invalid", "Use 2 to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit.", 400, { field: "name" });
  try {
    await docker().getVolume(n).inspect();
    throw new AppError("exists", `A volume called ${n} already exists.`, 409, { field: "name" });
  } catch (e) {
    if (e instanceof AppError) throw e;
    if ((e as { statusCode?: number }).statusCode !== 404) throw dockerError(e, "Couldn't check the name");
  }
  try {
    await docker().createVolume({ Name: n, Driver: "local", Labels: labels });
  } catch (e) {
    throw dockerError(e, `Couldn't create ${n}`);
  }
  afterChange();
  sizeCache = null;
  return { message: `Created the volume ${n}.` };
}

export async function getVolume(name: string): Promise<DockerVolume> {
  const { volumes } = await listVolumes();
  const v = volumes.find((x) => x.name === name);
  if (!v) throw new AppError("not_found", "That volume isn't there any more.", 404);
  return v;
}

/** Remove one volume. Docker refuses volumes any container (even a stopped one) mounts; so does Gluon, first, in words. */
export async function removeVolume(name: string, confirm?: string): Promise<{ message: string; freed: number | null }> {
  const v = await getVolume(name);
  const label = v.anonymous ? `unnamed volume ${name.slice(0, 12)}` : name;
  if (v.guard?.level === "block") throw new AppError("protected", `${v.guard.message} Gluon won't remove it.`, 409);
  if (v.containers.length) {
    throw new AppError("in_use", `${usersText(v.containers)} ${v.containers.length === 1 ? "uses" : "use"} this volume. Remove ${v.containers.length === 1 ? "that container" : "those containers"} first; the volume keeps their data until then.`, 409);
  }
  if ((v.guard?.level === "warn" || !v.anonymous) && confirm?.trim() !== name) throw new AppError("confirm", `Type ${name} to confirm.`, 400, { field: "confirm" });
  const size = await volumeSizes()
    .then((s) => s.sizes[name] ?? null)
    .catch(() => null);
  try {
    await docker().getVolume(name).remove();
  } catch (e) {
    throw dockerError(e, `Couldn't remove ${label}`);
  }
  afterChange();
  sizeCache = null;
  return { message: `Removed ${label}${size ? `, freeing ${formatBytes(size)}` : ""}.`, freed: size };
}

export function invalidateVolumeSizes() {
  sizeCache = null;
}
