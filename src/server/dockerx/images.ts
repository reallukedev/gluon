import "server-only";
import { docker } from "../docker/client";
import { invalidateApps } from "../docker/apps";
import { AppError } from "../errors";
import { publish } from "../events";
import { formatBytes, plural } from "@/lib/format";
import { dial, dockerError, dockerMessage, invalidateSnapshot, names, snapshot, usersText, type Snapshot } from "./core";
import type { ContainerRef, DockerImage, Guard, ImagesResponse, ImageUse, PullEvent } from "@/lib/docker-types";

interface RawImage {
  Id: string;
  ParentId?: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created: number;
  Size: number;
  SharedSize?: number;
  Containers?: number;
  Labels?: Record<string, string> | null;
}

// ---------------------------------------------------------------- references

/** Split "registry:5000/a/b:tag" into repository and tag (the colon after the last slash). */
export function splitRef(ref: string): { repo: string; tag: string | null; digest: string | null } {
  const at = ref.indexOf("@");
  const digest = at >= 0 ? ref.slice(at + 1) : null;
  const name = at >= 0 ? ref.slice(0, at) : ref;
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  if (colon > slash) return { repo: name.slice(0, colon), tag: name.slice(colon + 1), digest };
  return { repo: name, tag: null, digest };
}

const DOMAIN = String.raw`(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?))*(?::[0-9]+)?`;
const COMPONENT = String.raw`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`;
const TAG = String.raw`[\w][\w.-]{0,127}`;
const DIGEST = String.raw`sha256:[a-f0-9]{64}`;
const REF_RE = new RegExp(`^(?:${DOMAIN}/)?${COMPONENT}(?:/${COMPONENT})*(?::${TAG})?(?:@${DIGEST})?$`);

/** Check and tidy an image reference someone typed. Returns it with ":latest" when it had no tag. */
export function normalizeRef(input: string): string {
  const ref = input.trim().replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "");
  if (!ref) throw new AppError("invalid", "Type the name of an image, like jellyfin/jellyfin:latest.", 400, { field: "ref" });
  if (ref.length > 400 || !REF_RE.test(ref)) {
    throw new AppError("invalid", /[A-Z]/.test(ref.split("/").pop() ?? "") ? "Image names are lowercase." : "That isn't an image name. It looks like jellyfin/jellyfin:10.11 or ghcr.io/immich-app/immich-server:release.", 400, { field: "ref" });
  }
  const { tag, digest } = splitRef(ref);
  return tag || digest ? ref : `${ref}:latest`;
}

const isDigestRef = (r: string) => r.includes("@");
const realTag = (t: string) => t && t !== "<none>:<none>" && !isDigestRef(t);

/** The best name for an image in a sentence. */
export function imageLabel(i: Pick<DockerImage, "tags" | "repo" | "short">): string {
  return i.tags[0] ?? (i.repo ? `${i.repo} (untagged)` : `untagged image ${i.short}`);
}

// ---------------------------------------------------------------- listing

const GLUON_REPO = /(^|\/)(leech-gluon|gluon)(-gluon|-dev)?$|^tend(-dev)?$/;
const UMBREL_REPO = /^(ghcr\.io\/)?(getumbrel\/|dockurr\/umbrel$)/;

let totalCache: { at: number; value: number | null } | null = null;

/** Everything Docker keeps for images, counted once. From its disk-usage report (can be slow). */
export async function imagesTotal(maxWaitMs = 1500): Promise<number | null> {
  if (totalCache && Date.now() - totalCache.at < 30_000) return totalCache.value;
  const p = dial<{ LayersSize?: number }>({ path: "/system/df", method: "GET", query: { type: "image" } })
    .then((r) => {
      const v = typeof r.LayersSize === "number" ? r.LayersSize : null;
      totalCache = { at: Date.now(), value: v };
      return v;
    })
    .catch(() => null);
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), maxWaitMs))]);
}

function useOf(containers: ContainerRef[], tagged: boolean): ImageUse {
  if (containers.some((c) => c.state === "running" || c.state === "restarting" || c.state === "paused")) return "running";
  if (containers.length) return "stopped";
  return tagged ? "unused" : "leftover";
}

export async function listImages(): Promise<ImagesResponse> {
  let raw: RawImage[];
  const [snap, total] = await Promise.all([snapshot(), imagesTotal()]);
  try {
    raw = await dial<RawImage[]>({ path: "/images/json", method: "GET", query: { "shared-size": true } });
  } catch (e) {
    throw dockerError(e, "Couldn't list images");
  }
  return { images: buildImages(raw, snap), total, platform: snap.platform };
}

function buildImages(raw: RawImage[], snap: Snapshot): DockerImage[] {
  const users = new Map<string, ContainerRef[]>();
  for (const c of snap.containers) {
    const ref = snap.refs.get(c.Id);
    if (ref) users.set(c.ImageID, [...(users.get(c.ImageID) ?? []), ref]);
  }
  const byId = new Map(raw.map((r) => [r.Id, r]));

  const base = raw.map((r): DockerImage => {
    const tags = (r.RepoTags ?? []).filter(realTag);
    const digests = [...new Set([...(r.RepoDigests ?? []), ...(r.RepoTags ?? []).filter(isDigestRef)])];
    const repo = tags.length ? splitRef(tags[0]!).repo : digests.length ? splitRef(digests[0]!).repo : null;
    const containers = (users.get(r.Id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const shared = typeof r.SharedSize === "number" && r.SharedSize >= 0 ? r.SharedSize : null;
    const labels = r.Labels ?? {};
    return {
      id: r.Id,
      short: r.Id.replace(/^sha256:/, "").slice(0, 12),
      repo,
      tags,
      digests,
      created: r.Created * 1000,
      size: Math.max(0, r.Size),
      shared,
      own: Math.max(0, r.Size - (shared ?? 0)),
      containers,
      use: useOf(containers, tags.length > 0 || digests.length > 0),
      built: !!labels["com.docker.compose.image.builder"] || (!repo && !tags.length),
      baseOf: [],
      olderOf: null,
      app: containers.find((c) => c.app)?.app ?? null,
      guard: null,
    };
  });
  const images = new Map(base.map((i) => [i.id, i]));

  // Which in-use images are built on which: walk each in-use image's parents.
  const selfAncestors = new Set<string>();
  for (const img of base) {
    if (!img.containers.length) continue;
    let parent = byId.get(img.id)?.ParentId;
    const seen = new Set<string>();
    while (parent && images.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      const p = images.get(parent)!;
      const label = imageLabel(img);
      if (!p.baseOf.includes(label)) p.baseOf.push(label);
      if (snap.selfImages.has(img.id)) selfAncestors.add(parent);
      parent = byId.get(parent)?.ParentId;
    }
  }

  // An unused image with the same repository as one an app runs is an older version of it.
  const inUseRepo = new Map<string, DockerImage>();
  for (const i of base) if (i.repo && i.containers.length && i.app) inUseRepo.set(i.repo, i);
  for (const i of base) {
    if (i.containers.length || !i.repo) continue;
    const current = inUseRepo.get(i.repo);
    if (current?.app) {
      i.olderOf = current.app;
      i.app ??= current.app;
    }
  }

  for (const i of base) i.guard = guardFor(i, snap, selfAncestors);
  return base.sort((a, b) => b.created - a.created);
}

function guardFor(i: DockerImage, snap: Snapshot, selfAncestors: Set<string>): Guard | null {
  if (snap.selfImages.has(i.id) || i.containers.some((c) => c.self)) return { level: "block", who: "gluon", message: "Gluon runs from this image." };
  if (selfAncestors.has(i.id)) return { level: "block", who: "gluon", message: "Gluon's own image is built on this one. Without it, Gluon can't be rebuilt or restarted by its installer." };
  if (i.containers.some((c) => c.platform === "umbrel")) return { level: "block", who: "umbrel", message: "Umbrel itself runs from this image." };
  if (i.repo && GLUON_REPO.test(i.repo)) return { level: "warn", who: "gluon", message: "An image of Gluon, kept so an update can be rolled back." };
  if (i.repo && UMBREL_REPO.test(i.repo) && i.containers.length) return { level: "warn", who: "umbrel", message: "Part of Umbrel. Umbrel downloads it again when it needs it." };
  return null;
}

export async function getImage(id: string): Promise<DockerImage> {
  const { images } = await listImages();
  const img = images.find((i) => i.id === id || i.short === id || i.id === `sha256:${id}`);
  if (!img) throw new AppError("not_found", "That image isn't on the server any more.", 404);
  return img;
}

// ---------------------------------------------------------------- can it come back?

const remoteCache = new Map<string, { at: number; value: RemoteState }>();
export type RemoteState = { status: "same" | "newer" | "missing" | "unknown"; digest: string | null; message?: string };

/**
 * Ask the registry (through Docker) what a tag points at now: whether it can be downloaded again
 * and whether it's newer than the copy here. Cached for 30 minutes.
 */
export async function remoteState(ref: string, localIds: string[], fresh = false): Promise<RemoteState> {
  const key = `${ref}|${localIds.join(",")}`;
  const hit = remoteCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  let value: RemoteState;
  try {
    const r = await dial<{ Descriptor?: { digest?: string } }>({ path: `/distribution/${ref}/json`, method: "GET", signal: AbortSignal.timeout(8000) });
    const digest = r.Descriptor?.digest ?? null;
    value = { status: digest && localIds.some((l) => l.endsWith(digest.replace(/^sha256:/, ""))) ? "same" : "newer", digest };
  } catch (e) {
    const msg = dockerMessage(e);
    if (/denied|unauthorized|not found|manifest unknown|does not exist|no such host/i.test(msg)) value = { status: "missing", digest: null, message: msg };
    else value = { status: "unknown", digest: null, message: msg || "The registry didn't answer." };
  }
  remoteCache.set(key, { at: Date.now(), value });
  return value;
}

/** The digests an image is known by here (its id and its repository digests). */
export function localDigests(i: DockerImage): string[] {
  return [i.id, ...i.digests.map((d) => d.split("@")[1] ?? "")].filter(Boolean);
}

// ---------------------------------------------------------------- removing

interface RemoveOptions {
  /** Remove only this one tag (when the image has others). */
  tag?: string;
  /** Also remove the stopped containers that use it. */
  withContainers?: boolean;
  /** For guarded images: the name the person typed. */
  confirm?: string;
}

async function deleteRef(ref: string): Promise<void> {
  // References come from Docker itself (tags, digests, ids), so they're safe in the path as they are.
  await dial({ path: `/images/${ref}`, method: "DELETE", query: { force: false, noprune: false } });
}

/** Fresh check of who uses an image right now (not from the cached snapshot). */
async function usersNow(id: string): Promise<ContainerRef[]> {
  invalidateSnapshot();
  const snap = await snapshot();
  return snap.containers.filter((c) => c.ImageID === id).map((c) => snap.refs.get(c.Id)!);
}

/**
 * Remove an image by deleting each of its references without force, so Docker itself refuses if
 * a container starts using it in the meantime. Containers are only removed when asked, when all
 * of them are stopped, and never Gluon's or Umbrel's own.
 */
export async function removeImage(id: string, opts: RemoveOptions = {}): Promise<{ message: string; freed: number; removedContainers: string[] }> {
  const img = await getImage(id);
  const label = imageLabel(img);

  if (opts.tag) {
    if (!img.tags.includes(opts.tag)) throw new AppError("not_found", `${opts.tag} isn't a tag of this image any more.`, 404);
    if (img.tags.length > 1) {
      if (img.guard?.level === "block" && img.guard.who === "gluon") throw new AppError("protected", `${img.guard.message} Gluon won't change its tags.`, 409);
      try {
        await deleteRef(opts.tag);
      } catch (e) {
        throw dockerError(e, `Couldn't remove the tag ${opts.tag}`);
      }
      afterChange();
      return { message: `Removed the tag ${opts.tag}. The image stays as ${img.tags.filter((t) => t !== opts.tag).join(", ")}.`, freed: 0, removedContainers: [] };
    }
  }

  if (img.guard?.level === "block") throw new AppError("protected", `${img.guard.message} Gluon won't remove it.`, 409);
  if (img.guard?.level === "warn" && opts.confirm?.trim() !== label) throw new AppError("confirm", `Type ${label} to confirm removing it.`, 400, { field: "confirm" });

  const users = await usersNow(img.id);
  const running = users.filter((c) => c.state === "running" || c.state === "restarting" || c.state === "paused");
  if (running.length) {
    throw new AppError("in_use", `${usersText(running)} ${running.length === 1 && !running[0]!.app ? "is" : "are"} running on this image. Stop or remove ${running.length === 1 ? "it" : "them"} first.`, 409);
  }
  const removed: string[] = [];
  if (users.length) {
    if (!opts.withContainers) {
      throw new AppError("in_use", `${plural(users.length, "stopped container")} (${usersText(users)}) still use${users.length === 1 ? "s" : ""} this image. Remove ${users.length === 1 ? "it" : "them"} with the image, or leave the image.`, 409, { containers: users.map((u) => u.name) });
    }
    const off = users.find((u) => u.self || u.platform);
    if (off) throw new AppError("protected", `${off.name} belongs to ${off.self ? "Gluon" : "Umbrel"}, so Gluon won't remove it.`, 409);
    for (const u of users) {
      try {
        await docker().getContainer(u.id).remove({ v: false, force: false });
        removed.push(u.name);
      } catch (e) {
        afterChange();
        throw dockerError(e, removed.length ? `Removed ${names(removed)}, but not ${u.name}` : `Couldn't remove ${u.name}`);
      }
    }
  }

  // Tags first, then digest references; the last one removes the image. Anything left (an image
  // with no references at all) goes by id.
  const refs = [...img.tags, ...img.digests];
  try {
    if (!refs.length) await deleteRef(img.id);
    for (const r of refs) {
      try {
        await deleteRef(r);
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404) continue; // went with an earlier reference
        throw e;
      }
    }
    // Still there under its id (references Docker doesn't list)? Remove it by id.
    try {
      await docker().getImage(img.id).inspect();
      await deleteRef(img.id);
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
  } catch (e) {
    afterChange();
    throw dockerError(e, removed.length ? `Removed ${names(removed)}, but not the image` : `Couldn't remove ${label}`);
  }
  afterChange();
  const withCtr = removed.length ? ` and ${plural(removed.length, "stopped container")}` : "";
  return { message: `Removed ${label}${withCtr}${img.own > 0 ? `, freeing about ${formatBytes(img.own)}` : ""}.`, freed: img.own, removedContainers: removed };
}

export function afterChange() {
  invalidateSnapshot();
  invalidateApps();
  totalCache = null;
  publish("docker.resources", { at: Date.now() });
}

// ---------------------------------------------------------------- pulling

interface RawPull {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number; units?: string };
  error?: string;
  errorDetail?: { message?: string };
}

export function pullErrorText(msg: string, ref: string): string {
  if (/manifest unknown|not found|manifest for .* not found/i.test(msg)) return `The registry has no ${ref}. Check the name and tag.`;
  if (/pull access denied|unauthorized|denied|authentication required/i.test(msg)) return `The registry refused ${ref}: it doesn't exist, or it needs a login (Gluon can only download public images).`;
  if (/toomanyrequests|rate limit/i.test(msg)) return "Docker Hub's download limit for this address was reached. Try again in a few hours.";
  if (/no space left/i.test(msg)) return "The disk Docker uses is full. Free some space (Disk use shows what Docker can let go of) and try again.";
  if (/timeout|i\/o timeout|no such host|connection refused|network is unreachable|TLS handshake/i.test(msg)) return "Couldn't reach the registry. Check the server's internet connection and try again.";
  if (/no matching manifest/i.test(msg)) return `${ref} isn't published for this server's processor.`;
  return msg || "The download failed.";
}

/**
 * Download an image, reporting each layer. Docker sends a JSON line per change; these are folded
 * into one event per layer phase, at most every 200 ms per layer.
 */
export async function pullImage(input: string, emit: (e: PullEvent) => void, signal: AbortSignal): Promise<{ ok: boolean; message: string; changed: boolean; imageId: string | null; users: ContainerRef[] }> {
  const ref = normalizeRef(input);
  const before = await docker()
    .getImage(ref)
    .inspect()
    .then((i) => i.Id)
    .catch(() => null);
  emit({ type: "status", text: before ? `Checking for a newer ${ref}…` : `Downloading ${ref}…` });

  let stream: NodeJS.ReadableStream;
  try {
    stream = (await docker().pull(ref, { abortSignal: signal })) as NodeJS.ReadableStream;
  } catch (e) {
    const message = pullErrorText(dockerMessage(e), ref);
    return { ok: false, message, changed: false, imageId: before, users: [] };
  }

  let failure: string | null = null;
  const lastEmit = new Map<string, number>();
  const phaseOf = (s: string): Extract<PullEvent, { type: "layer" }>["phase"] | null => {
    if (/^Pulling fs layer|^Waiting/.test(s)) return "waiting";
    if (/^Downloading/.test(s)) return "downloading";
    if (/^Verifying Checksum/.test(s)) return "verifying";
    if (/^Download complete/.test(s)) return "downloaded";
    if (/^Extracting/.test(s)) return "extracting";
    if (/^Pull complete/.test(s)) return "done";
    if (/^Already exists/.test(s)) return "exists";
    return null;
  };
  await new Promise<void>((resolve) => {
    let buf = "";
    const handle = (line: string) => {
      let m: RawPull;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.error || m.errorDetail?.message) {
        failure = m.errorDetail?.message ?? m.error ?? "The download failed.";
        return;
      }
      const status = m.status ?? "";
      const phase = phaseOf(status);
      if (phase && m.id) {
        const now = Date.now();
        const key = `${m.id}:${phase}`;
        const moving = phase === "downloading" || phase === "extracting";
        if (moving && now - (lastEmit.get(key) ?? 0) < 200) return;
        lastEmit.set(key, now);
        // containerd reports unpacking in seconds ("units": "s"), not bytes: no bar for that.
        const bytes = !m.progressDetail?.units;
        emit({ type: "layer", id: m.id, phase, current: bytes ? m.progressDetail?.current : undefined, total: bytes ? m.progressDetail?.total : undefined });
        return;
      }
      if (/^Digest:|^Status:|^Pulling from/.test(status)) emit({ type: "status", text: status.replace(/^Status:\s*/, "") });
    };
    stream.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    });
    stream.on("end", () => {
      if (buf.trim()) handle(buf.trim());
      resolve();
    });
    stream.on("error", (e: Error) => {
      failure ??= signal.aborted ? "Stopped. Layers that finished stay on the server." : e.message;
      resolve();
    });
    signal.addEventListener("abort", () => {
      failure ??= "Stopped. Layers that finished stay on the server.";
      (stream as unknown as { destroy?: () => void }).destroy?.();
      resolve();
    });
  });

  afterChange();
  if (failure) return { ok: false, message: pullErrorText(failure, ref), changed: false, imageId: before, users: [] };
  const after = await docker()
    .getImage(ref)
    .inspect()
    .then((i) => i.Id)
    .catch(() => null);
  const changed = !!after && after !== before;
  const users = before && changed ? await usersNow(before) : [];
  let message: string;
  if (!before) message = `Downloaded ${ref}.`;
  else if (!changed) message = `${ref} was already the newest version.`;
  else if (users.length) message = `Downloaded a newer ${ref}. ${usersText(users)} still ${users.length === 1 ? "runs" : "run"} the old one until ${users.length === 1 ? "it's" : "they're"} recreated (update the app to switch).`;
  else message = `Downloaded a newer ${ref}. The old version stays until you remove it.`;
  return { ok: true, message, changed, imageId: after, users };
}

