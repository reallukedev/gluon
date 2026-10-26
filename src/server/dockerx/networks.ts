import "server-only";
import { docker } from "../docker/client";
import { AppError } from "../errors";
import { appRef, dial, dockerError, findContainer, snapshot, usersText, type Snapshot } from "./core";
import { afterChange } from "./images";
import type { Attachable, DockerNetwork, Guard, NetworkMember, NetworksResponse } from "@/lib/docker-types";

interface RawNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Scope?: string;
  Created?: string;
  Internal?: boolean;
  Attachable?: boolean;
  EnableIPv6?: boolean;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] | null } | null;
  Labels?: Record<string, string> | null;
}

const BUILTIN = new Set(["bridge", "host", "none"]);
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** Containers on the host's network, another container's, or none can't join a network. */
const sharesStack = (mode: string | undefined) => mode === "host" || mode === "none" || !!mode?.startsWith("container:");

export async function listNetworks(): Promise<NetworksResponse> {
  const snap = await snapshot();
  let raw: RawNetwork[];
  try {
    raw = await dial<RawNetwork[]>({ path: "/networks", method: "GET" });
  } catch (e) {
    throw dockerError(e, "Couldn't list networks");
  }
  const containers: Attachable[] = snap.containers
    .filter((c) => !sharesStack(c.HostConfig?.NetworkMode))
    .map((c) => {
      const r = snap.refs.get(c.Id)!;
      return { id: c.Id, name: r.name, state: r.state, line: r.line, app: r.app, networks: Object.keys(c.NetworkSettings?.Networks ?? {}), self: r.self, platform: r.platform };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { networks: buildNetworks(raw, snap), containers };
}

function buildNetworks(raw: RawNetwork[], snap: Snapshot): DockerNetwork[] {
  const members = new Map<string, NetworkMember[]>();
  const idByName = new Map(raw.map((n) => [n.Name, n.Id]));
  for (const c of snap.containers) {
    const ref = snap.refs.get(c.Id);
    if (!ref) continue;
    for (const [name, n] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
      // A container that was never started has no endpoint (no NetworkID) yet, but still joins
      // the network when it starts, so it counts.
      const id = n.NetworkID || idByName.get(name);
      if (!id) continue;
      const mode = c.HostConfig?.NetworkMode ?? "";
      const primary = mode === name || mode === id || (mode === "default" && name === "bridge");
      members.set(id, [...(members.get(id) ?? []), { ...ref, ipv4: n.IPAddress || null, ipv6: n.GlobalIPv6Address || null, primary }]);
    }
  }
  return raw
    .map((n): DockerNetwork => {
      const labels = n.Labels ?? {};
      const containers = (members.get(n.Id) ?? []).sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name));
      const project = labels["com.docker.compose.project"] ?? null;
      const byProject = project ? snap.appById.get(project) : undefined;
      const created = n.Created ? Date.parse(n.Created) : NaN;
      const net: DockerNetwork = {
        id: n.Id,
        short: n.Id.slice(0, 12),
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope ?? "local",
        created: Number.isFinite(created) ? created : null,
        internal: !!n.Internal,
        attachable: !!n.Attachable,
        ipv6: !!n.EnableIPv6,
        subnets: (n.IPAM?.Config ?? []).filter((c) => c.Subnet).map((c) => ({ subnet: c.Subnet!, gateway: c.Gateway || null })),
        builtin: BUILTIN.has(n.Name),
        project,
        app: containers.find((c) => c.app)?.app ?? (byProject ? appRef(byProject) : null),
        containers,
        guard: null,
      };
      net.guard = guardFor(net);
      return net;
    })
    .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
}

function guardFor(n: DockerNetwork): Guard | null {
  if (n.builtin) return { level: "block", who: "gluon", message: "One of Docker's own networks. It can't be removed." };
  if (n.containers.some((c) => c.platform === "umbrel") || /^umbrel_/.test(n.name)) return { level: "warn", who: "umbrel", message: "Umbrel's apps talk to each other over this network." };
  return null;
}

async function getNetwork(idOrName: string): Promise<DockerNetwork> {
  const { networks } = await listNetworks();
  const n = networks.find((x) => x.id === idOrName || x.name === idOrName || x.short === idOrName);
  if (!n) throw new AppError("not_found", "That network isn't there any more.", 404);
  return n;
}

// ---------------------------------------------------------------- create

const CIDR4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const IP4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ip4(s: string): number | null {
  const m = IP4.exec(s);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function parseCidr(s: string): { base: number; bits: number } | null {
  const m = CIDR4.exec(s);
  if (!m) return null;
  const base = ip4(m.slice(1, 5).join("."));
  const bits = Number(m[5]);
  if (base === null || bits < 8 || bits > 30) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, bits };
}

const overlaps = (a: { base: number; bits: number }, b: { base: number; bits: number }) => {
  const bits = Math.min(a.bits, b.bits);
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((a.base & mask) >>> 0) === ((b.base & mask) >>> 0);
};

export interface CreateNetworkInput {
  name: string;
  subnet?: string | null;
  gateway?: string | null;
  internal?: boolean;
  attachable?: boolean;
}

export async function createNetwork(input: CreateNetworkInput): Promise<{ message: string; id: string }> {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) throw new AppError("invalid", "Use letters, digits, dots, dashes or underscores (up to 63), starting with a letter or digit.", 400, { field: "name" });
  const { networks } = await listNetworks();
  if (networks.some((n) => n.name === name)) throw new AppError("exists", `A network called ${name} already exists.`, 409, { field: "name" });
  const ipam: { Subnet: string; Gateway?: string }[] = [];
  if (input.subnet?.trim()) {
    const c = parseCidr(input.subnet.trim());
    if (!c) throw new AppError("invalid", "Write the subnet like 172.40.0.0/24 (a prefix between /8 and /30).", 400, { field: "subnet" });
    const clash = networks.find((n) => n.subnets.some((s) => {
      const o = parseCidr(s.subnet);
      return o && overlaps(o, c);
    }));
    if (clash) throw new AppError("invalid", `That range overlaps ${clash.name} (${clash.subnets.map((s) => s.subnet).join(", ")}). Pick another, or leave it empty and Docker picks a free one.`, 400, { field: "subnet" });
    const entry: { Subnet: string; Gateway?: string } = { Subnet: input.subnet.trim() };
    if (input.gateway?.trim()) {
      const gw = ip4(input.gateway.trim());
      const mask = (0xffffffff << (32 - c.bits)) >>> 0;
      if (gw === null || ((gw & mask) >>> 0) !== c.base) throw new AppError("invalid", "The gateway must be an address inside the subnet, like 172.40.0.1.", 400, { field: "gateway" });
      entry.Gateway = input.gateway.trim();
    }
    ipam.push(entry);
  } else if (input.gateway?.trim()) {
    throw new AppError("invalid", "Set a subnet to choose the gateway, or leave both empty.", 400, { field: "gateway" });
  }
  try {
    const net = await docker().createNetwork({
      Name: name,
      Driver: "bridge",
      CheckDuplicate: true,
      Internal: !!input.internal,
      Attachable: input.attachable !== false,
      ...(ipam.length ? { IPAM: { Driver: "default", Config: ipam } } : {}),
      Labels: { "app.gluon.created": "1" },
    });
    afterChange();
    return { message: `Created the network ${name}.`, id: net.id };
  } catch (e) {
    throw dockerError(e, `Couldn't create ${name}`);
  }
}

// ---------------------------------------------------------------- remove

export async function removeNetwork(idOrName: string, confirm?: string): Promise<{ message: string }> {
  const n = await getNetwork(idOrName);
  if (n.builtin) throw new AppError("protected", `${n.name} is one of Docker's own networks and can't be removed.`, 409);
  if (n.containers.length) {
    throw new AppError("in_use", `${usersText(n.containers)} ${n.containers.length === 1 ? "is" : "are"} connected to ${n.name}. Disconnect ${n.containers.length === 1 ? "it" : "them"} first.`, 409);
  }
  if (n.guard?.level === "warn" && confirm?.trim() !== n.name) throw new AppError("confirm", `Type ${n.name} to confirm.`, 400, { field: "confirm" });
  try {
    await docker().getNetwork(n.id).remove();
  } catch (e) {
    throw dockerError(e, `Couldn't remove ${n.name}`);
  }
  afterChange();
  return { message: `Removed the network ${n.name}.` };
}

// ---------------------------------------------------------------- connect / disconnect

export async function connectContainer(network: string, container: string, ipv4?: string | null): Promise<{ message: string }> {
  const n = await getNetwork(network);
  const { info, ref } = await findContainer(container);
  if (n.builtin && n.name !== "bridge") throw new AppError("invalid", `Containers can't be connected to ${n.name} after they're created.`, 400);
  if (sharesStack(info.HostConfig?.NetworkMode)) throw new AppError("invalid", `${ref.name} uses ${info.HostConfig?.NetworkMode === "host" ? "the server's own network" : "another container's network"}, so it can't join other networks.`, 400);
  if (n.containers.some((c) => c.id === info.Id)) throw new AppError("conflict", `${ref.name} is already on ${n.name}.`, 409);
  if (ref.self) throw new AppError("protected", "Gluon's own network settings are left alone.", 409);
  const cfg: Record<string, unknown> = { Container: info.Id };
  if (ipv4?.trim()) {
    if (ip4(ipv4.trim()) === null) throw new AppError("invalid", "Write the address like 172.40.0.20.", 400, { field: "ip" });
    if (!n.subnets.length) throw new AppError("invalid", `${n.name} has no fixed range, so Docker picks the address.`, 400, { field: "ip" });
    cfg.EndpointConfig = { IPAMConfig: { IPv4Address: ipv4.trim() } };
  }
  try {
    await docker().getNetwork(n.id).connect(cfg);
  } catch (e) {
    throw dockerError(e, `Couldn't connect ${ref.name}`);
  }
  afterChange();
  return { message: `Connected ${ref.name} to ${n.name}.${ref.state === "running" ? "" : " It gets an address when it starts."}` };
}

export async function disconnectContainer(network: string, container: string): Promise<{ message: string; lastNetwork: boolean }> {
  const n = await getNetwork(network);
  const { info, ref } = await findContainer(container);
  if (ref.self) throw new AppError("protected", "Gluon won't disconnect itself.", 409);
  if (ref.platform) throw new AppError("protected", `${ref.name} is part of Umbrel. Umbrel manages its networks.`, 409);
  if (!n.containers.some((c) => c.id === info.Id)) throw new AppError("conflict", `${ref.name} isn't on ${n.name}.`, 409);
  // The network a container was created on carries its published ports; taking it away quietly
  // breaks the app. That's changed by recreating the container, not from here.
  const mode = info.HostConfig?.NetworkMode ?? "";
  if (mode === n.name || mode === n.id || (mode === "default" && n.name === "bridge")) {
    throw new AppError("primary", `${n.name} is the network ${ref.name} was created on (its published ports go through it). Change it in the app's Compose file instead.`, 409);
  }
  const lastNetwork = Object.keys(info.NetworkSettings?.Networks ?? {}).length <= 1;
  try {
    await docker().getNetwork(n.id).disconnect({ Container: info.Id, Force: false });
  } catch (e) {
    throw dockerError(e, `Couldn't disconnect ${ref.name}`);
  }
  afterChange();
  return { message: `Disconnected ${ref.name} from ${n.name}.${lastNetwork ? " It has no network now, so it can only be reached from inside." : ""}`, lastNetwork };
}
