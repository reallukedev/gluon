import "server-only";
import { hostListeners } from "../network/sockets";
import { listApps } from "../docker/apps";
import { docker } from "../docker/client";
import { umbrelApps, umbrelStores } from "../platform/umbrel";
import { missingImages } from "./images";
import { parseCompose, readNetworks, readServices } from "@/lib/builder/compose";
import { containerNames } from "@/lib/builder/render";
import { isLocalImage } from "@/lib/builder/names";
import type { AppSpec, BuilderTarget, DockerNetworkInfo, Issue, ServerCheck } from "@/lib/builder-types";

/** Networks an app can join: user-made ones, not host, none or Docker's default bridge. */
export async function dockerNetworks(): Promise<DockerNetworkInfo[]> {
  const list = await docker().listNetworks();
  return list
    .filter((n) => n.Name && !["host", "none", "bridge"].includes(n.Name) && n.Driver !== "null" && n.Driver !== "host")
    .map((n) => ({ name: n.Name, driver: n.Driver ?? "bridge", project: n.Labels?.["com.docker.compose.project"] ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Checks that need the server: ports something else already listens on, names Umbrel already
 * uses, container names taken, images that don't exist. `ownId` is the app's own id where it
 * runs, so an update doesn't collide with itself.
 */
export async function serverChecks(spec: AppSpec, target: BuilderTarget, ownId: string | null, opts: { images?: boolean } = {}): Promise<ServerCheck> {
  const issues: Issue[] = [];
  const parsed = parseCompose(spec.compose);
  const services = parsed.ok ? readServices(parsed.doc) : [];

  // ------------------------------------------------ who uses which port
  const used = new Map<string, string>();
  const [listeners, apps, umbrel] = await Promise.all([
    hostListeners().catch(() => []),
    listApps().catch(() => []),
    target === "umbrel" ? umbrelApps(5_000).catch(() => []) : Promise.resolve([]),
  ]);
  const ownContainer = (name: string) => !!ownId && (name.startsWith(`${ownId}_`) || name.startsWith(`${ownId}-`) || name === ownId);
  for (const a of apps) {
    const mine = !!ownId && (a.id === ownId || a.containers.every((c) => ownContainer(c.name)));
    for (const c of a.containers) {
      for (const p of c.ports) {
        const key = `${p.host}/${p.proto}`;
        if (mine || ownContainer(c.name)) continue;
        if (!used.has(key)) used.set(key, a.name);
      }
    }
  }
  for (const u of umbrel) {
    if (u.id === ownId || !u.port) continue;
    const key = `${u.port}/tcp`;
    if (!used.has(key)) used.set(key, u.name);
  }
  for (const l of listeners) {
    const key = `${l.local.port}/${l.proto}`;
    if (used.has(key)) continue;
    const proc = l.processes[0]?.name ?? "";
    // docker-proxy for our own containers is already excluded above; for others the app name is better.
    if (proc === "docker-proxy") continue;
    used.set(key, proc ? `${proc} (a program on this server)` : "something on this server");
  }
  const ports = [...used].map(([k, by]) => {
    const [port, proto] = k.split("/");
    return { port: Number(port), proto: proto as "tcp" | "udp", by };
  });

  const web = spec.web;
  const webSvc = services.find((s) => s.name === web.service);
  if (web.port && web.service) {
    const by = used.get(`${web.port}/tcp`);
    if (by && !(webSvc?.hostNetwork && ownId)) issues.push({ id: "srv-web-port", level: "error", message: `Port ${web.port} is already used by ${by}. Pick another port for the app to open on.`, field: "web.port" });
  }
  for (const s of services) {
    if (s.hostNetwork) continue;
    s.ports.forEach((p, i) => {
      if (!p.host || p.raw !== null) return;
      if (target === "umbrel" && p.host === web.port && p.proto === "tcp") return; // reported with the web port
      const by = used.get(`${p.host}/${p.proto}`);
      if (by) issues.push({ id: `srv-port-${s.name}-${i}`, level: "error", message: `Port ${p.host}${p.proto === "udp" ? "/udp" : ""} of “${s.name}” is already used by ${by}.`, field: `services.${s.name}.ports.${i}` });
    });
  }

  // ------------------------------------------------ names
  if (target === "umbrel") {
    const name = spec.details.name.trim().toLowerCase();
    const installed = umbrel.find((u) => u.id !== ownId && u.name.trim().toLowerCase() === name);
    let listed: string | null = null;
    if (!installed) {
      const stores = await umbrelStores().catch(() => []);
      for (const st of stores) for (const a of st.apps) if (a.id !== ownId && a.name.trim().toLowerCase() === name) listed = st.name;
    }
    if (installed) issues.push({ id: "srv-name", level: "warning", message: `Umbrel already has an app called ${installed.name}. Both tiles would read the same; consider another name.`, field: "details.name" });
    else if (listed) issues.push({ id: "srv-name", level: "info", message: `${listed} also has an app called ${spec.details.name.trim()}.`, field: "details.name" });
  }

  // ------------------------------------------------ container names
  try {
    const existing = await docker().listContainers({ all: true });
    const taken = new Map<string, string>();
    for (const c of existing) for (const n of c.Names ?? []) taken.set(n.replace(/^\//, ""), c.Labels?.["com.docker.compose.project"] ?? "");
    const appId = ownId ?? "";
    for (const n of containerNames(spec, appId || "app", target)) {
      const project = taken.get(n);
      if (project === undefined || ownContainer(n)) continue;
      if (appId && (project === appId)) continue;
      const fixed = services.find((s) => s.containerName === n);
      if (fixed) issues.push({ id: `srv-cname-${fixed.name}`, level: "error", message: `A container called ${n} already exists on this server. Remove the fixed name of “${fixed.name}”, or pick another.`, field: `services.${fixed.name}.advanced` });
    }
  } catch {
    /* Docker unreachable: the publish will say so */
  }

  // ------------------------------------------------ networks and the GPU
  const external = parsed.ok ? readNetworks(parsed.doc).filter((n) => n.external) : [];
  const wantsGpu = services.filter((s) => s.gpu);
  if (target === "compose" && (external.length || wantsGpu.length)) {
    const [nets, info] = await Promise.all([
      external.length ? docker().listNetworks().catch(() => null) : Promise.resolve(null),
      wantsGpu.length ? (docker().info() as Promise<{ Runtimes?: Record<string, unknown> }>).catch(() => null) : Promise.resolve(null),
    ]);
    if (nets) {
      const have = new Set(nets.map((n) => n.Name));
      for (const n of external) {
        if (have.has(n.name)) continue;
        const svc = services.find((s) => s.networks.includes(n.name));
        issues.push({ id: `srv-net-${n.name}`, level: "error", message: `The network “${n.name}” doesn't exist on this server, so the app can't join it. Pick one that exists, or let the app make its own.`, field: svc ? `services.${svc.name}.networks` : undefined });
      }
    }
    if (info && !Object.keys(info.Runtimes ?? {}).some((r) => r.startsWith("nvidia"))) {
      for (const s of wantsGpu) issues.push({ id: `srv-gpu-${s.name}`, level: "warning", message: `“${s.name}” asks for the NVIDIA GPU, but Docker on this server has no NVIDIA runtime. Install the NVIDIA Container Toolkit, or it won't start.`, field: `services.${s.name}.gpu` });
    }
  }

  // ------------------------------------------------ images
  if (opts.images) {
    const refs = services.filter((s) => !s.build && s.image && !isLocalImage(s.image)).map((s) => s.image);
    for (const m of await missingImages(refs)) {
      const svc = services.find((s) => s.image === m.ref);
      issues.push({ id: `srv-image-${svc?.name ?? m.ref}`, level: "error", message: `“${svc?.name ?? m.ref}”: ${m.reason}`, field: svc ? `services.${svc.name}.image` : undefined });
    }
  }
  return { issues, ports };
}
