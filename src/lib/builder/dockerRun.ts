/**
 * `docker run …` → a compose service. Reads the command the way a POSIX shell would split it
 * (quotes, backslash and backtick line continuations, LinuxServer's `#optional` comments), then
 * maps every flag it knows to compose. Flags that can't carry over, or that it doesn't know, are
 * reported in plain words rather than dropped.
 *
 * Isomorphic and pure: the New app flow runs it as the person types.
 */
import { Document, Scalar, isScalar, isSeq, isMap, type YAMLMap } from "yaml";
import { DATA_PREFIX, PENDING_KEY, parsePortString, stringify } from "./compose";
import { dataFolderFor, imageError, mediaKind, SERVICE_RE, RESERVED_SERVICES, slugify } from "./names";
import { nameForImage, prepareCompose, serviceNameFor, titleize, type Prepared } from "./start";
import type { BuilderTarget } from "@/lib/builder-types";

export interface RunNote {
  level: "info" | "warning";
  /** The flag it is about, as typed ("--env-file"), when there is one. */
  flag?: string;
  text: string;
}

export interface DockerRun {
  ok: boolean;
  /** Why nothing could be made (no docker run, no image). */
  error: string | null;
  image: string;
  /** From --name, as typed. */
  containerName: string | null;
  service: string;
  /** The compose service, as plain data. */
  spec: Record<string, unknown>;
  /** Existing networks it joins (become external networks). */
  networks: string[];
  notes: RunNote[];
  /** Flags Gluon doesn't know, as typed. */
  unknown: string[];
}

// ---------------------------------------------------------------- shell words

/** A `$` that was inside single quotes: literal, never a variable. */
const LIT = "\u0001";

interface Split {
  /** Each command's words; commands are separated by &&, ||, ; or |. */
  commands: string[][];
}

/** Split a command line into commands and words like a shell, without expanding anything. */
export function splitCommand(input: string): Split {
  // Line continuations: backslash, PowerShell backtick or cmd caret at the end of a line,
  // tolerating trailing spaces after them (a common copy-paste accident).
  const src = input
    .replace(/\r\n?/g, "\n")
    // `#optional` (LinuxServer's READMEs) is a comment that expands to nothing.
    .replace(/`#[^`\n]*`/g, "")
    // Whole-line comments between continued lines would end the command in a shell; READMEs
    // often have them, so they're dropped instead.
    .replace(/^[ \t]*#.*(\n|$)/gm, "")
    .replace(/(?:\\|`|\^)[ \t]*\n/g, " ");
  const commands: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let has = false;
  const push = () => {
    if (has || cur) words.push(cur);
    cur = "";
    has = false;
  };
  const end = () => {
    push();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const body = close < 0 ? src.slice(i + 1) : src.slice(i + 1, close);
      cur += body.replace(/\$/g, LIT);
      has = true;
      i = close < 0 ? src.length : close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\" && j + 1 < src.length && /["\\$`\n]/.test(src[j + 1]!)) {
          if (src[j + 1] !== "\n") cur += src[j + 1];
          j++;
        } else cur += src[j];
      }
      has = true;
      i = j;
      continue;
    }
    if (c === "`") {
      // Command substitution: kept as written and reported.
      const close = src.indexOf("`", i + 1);
      cur += close < 0 ? src.slice(i) : src.slice(i, close + 1);
      has = true;
      i = close < 0 ? src.length : close;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < src.length) {
        cur += src[++i];
        has = true;
      }
      continue;
    }
    if (c === "#" && !has && !cur) {
      // A comment runs to the end of its line.
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl - 1;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      // A newline without a continuation ends the command too.
      end();
      while (i + 1 < src.length && "|&".includes(src[i + 1]!)) i++;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    cur += c;
    has = true;
  }
  end();
  return { commands };
}

// ---------------------------------------------------------------- flags

type Kind = "bool" | "value";

/** docker run's flags (Docker 27/28), long name → kind, with their short forms. */
const LONG: Record<string, Kind> = {
  "add-host": "value", annotation: "value", attach: "value", "blkio-weight": "value", "blkio-weight-device": "value",
  "cap-add": "value", "cap-drop": "value", "cgroup-parent": "value", cgroupns: "value", cidfile: "value", "cpu-count": "value",
  "cpu-percent": "value", "cpu-period": "value", "cpu-quota": "value", "cpu-rt-period": "value", "cpu-rt-runtime": "value",
  "cpu-shares": "value", cpus: "value", "cpuset-cpus": "value", "cpuset-mems": "value", detach: "bool", "detach-keys": "value",
  device: "value", "device-cgroup-rule": "value", "device-read-bps": "value", "device-read-iops": "value",
  "device-write-bps": "value", "device-write-iops": "value", "disable-content-trust": "bool", dns: "value",
  "dns-option": "value", "dns-opt": "value", "dns-search": "value", domainname: "value", entrypoint: "value", env: "value",
  "env-file": "value", expose: "value", gpus: "value", "group-add": "value", "health-cmd": "value", "health-interval": "value",
  "health-retries": "value", "health-start-interval": "value", "health-start-period": "value", "health-timeout": "value",
  help: "bool", hostname: "value", init: "bool", interactive: "bool", ip: "value", ip6: "value", ipc: "value",
  isolation: "value", "kernel-memory": "value", label: "value", "label-file": "value", link: "value", "link-local-ip": "value",
  "log-driver": "value", "log-opt": "value", "mac-address": "value", memory: "value", "memory-reservation": "value",
  "memory-swap": "value", "memory-swappiness": "value", mount: "value", name: "value", net: "value", "net-alias": "value",
  network: "value", "network-alias": "value", "no-healthcheck": "bool", "oom-kill-disable": "bool", "oom-score-adj": "value",
  pid: "value", "pids-limit": "value", platform: "value", privileged: "bool", publish: "value", "publish-all": "bool",
  pull: "value", quiet: "bool", "read-only": "bool", restart: "value", rm: "bool", runtime: "value", "security-opt": "value",
  "shm-size": "value", "sig-proxy": "bool", "stop-signal": "value", "stop-timeout": "value", "storage-opt": "value",
  sysctl: "value", tmpfs: "value", tty: "bool", ulimit: "value", user: "value", userns: "value", uts: "value", volume: "value",
  "volume-driver": "value", "volumes-from": "value", workdir: "value", "use-api-socket": "bool",
};

const SHORT: Record<string, string> = {
  a: "attach", c: "cpu-shares", d: "detach", e: "env", h: "hostname", i: "interactive", l: "label", m: "memory", p: "publish",
  P: "publish-all", q: "quiet", t: "tty", u: "user", v: "volume", w: "workdir",
};

/** Flags that carry nothing over, on purpose. */
const SILENT = new Set(["detach", "attach", "detach-keys", "sig-proxy", "quiet", "disable-content-trust", "help"]);

/** Known flags compose can't express (or that only make sense for a one-off run). */
const UNSUPPORTED: Record<string, string> = {
  "env-file": "reads variables from a file that isn't on the server. Add them under Environment instead.",
  "label-file": "reads labels from a file that isn't on the server. Add them as labels instead.",
  "volumes-from": "borrows another container's volumes, which a separate app can't do. Mount the same folders instead.",
  "volume-driver": "picks a volume driver; app data folders don't use one.",
  cidfile: "writes the container id to a file; there's nothing to write it for here.",
  "kernel-memory": "is no longer supported by Docker.",
  isolation: "only applies to Windows containers.",
  "link-local-ip": "needs a network set up for it; add it in Compose if you need it.",
  ip: "gives a fixed address on a network; add it under that network in Compose if you need it.",
  ip6: "gives a fixed address on a network; add it under that network in Compose if you need it.",
  "cpu-count": "only applies to Windows containers.",
  "cpu-percent": "only applies to Windows containers.",
  annotation: "sets OCI annotations, which compose doesn't carry.",
};

/** Simple flag → compose key with the value as written. */
const DIRECT: Record<string, string> = {
  hostname: "hostname", domainname: "domainname", workdir: "working_dir", user: "user", "shm-size": "shm_size",
  "stop-signal": "stop_signal", pid: "pid", ipc: "ipc", uts: "uts", userns: "userns_mode", platform: "platform",
  runtime: "runtime", "mac-address": "mac_address", "cgroup-parent": "cgroup_parent", cgroupns: "cgroup",
  "cpuset-cpus": "cpuset",
};

/** Flags that may repeat and become a list. */
const LISTS: Record<string, string> = {
  "cap-add": "cap_add", "cap-drop": "cap_drop", device: "devices", "add-host": "extra_hosts", dns: "dns", "dns-search": "dns_search",
  "dns-option": "dns_opt", "dns-opt": "dns_opt", "security-opt": "security_opt", expose: "expose", "group-add": "group_add",
  "device-cgroup-rule": "device_cgroup_rules", tmpfs: "tmpfs", link: "links",
};

const NUMBERS: Record<string, string> = {
  "cpu-shares": "cpu_shares", "oom-score-adj": "oom_score_adj", "pids-limit": "pids_limit", "memory-swappiness": "mem_swappiness",
  "cpu-period": "cpu_period", "cpu-quota": "cpu_quota", "cpu-rt-period": "cpu_rt_period", "cpu-rt-runtime": "cpu_rt_runtime",
};

const RESTARTS = /^(no|always|unless-stopped|on-failure(:\d+)?)$/;

// ---------------------------------------------------------------- parse

/** [sudo [-E]] [VAR=x…] docker|podman|nerdctl [global flags] [container] run|create … */
function isRun(c: string[]): boolean {
  let i = 0;
  if (c[i] === "sudo") for (i++; c[i]?.startsWith("-"); i++);
  while (c[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[i]!)) i++;
  if (!c[i] || !/(^|\/)(docker|podman|nerdctl)(\.exe)?$/.test(c[i]!)) return c[i] === "run";
  for (i++; c[i]?.startsWith("-"); i += c[i]!.includes("=") || ["-D", "--debug"].includes(c[i]!) ? 1 : 2);
  if (c[i] === "container") i++;
  return c[i] === "run" || c[i] === "create";
}

/** Read `docker run` (or podman/nerdctl) with its flags; the rest is the image and its command. */
export function parseDockerRun(input: string): DockerRun {
  const notes: RunNote[] = [];
  const unknown: string[] = [];
  const fail = (error: string): DockerRun => ({ ok: false, error, image: "", containerName: null, service: "app", spec: {}, networks: [], notes, unknown });
  if (!input.trim()) return fail("Paste a docker run command.");
  const { commands } = splitCommand(input);
  // Prompts ($ or >) at the start of a line aren't part of the command.
  for (const c of commands) if (c[0] === "$" || c[0] === ">" || c[0] === "PS>") c.shift();
  const runAt = commands.findIndex((c) => isRun(c));
  if (runAt < 0) {
    if (commands.some((c) => c.some((x) => x === "compose" || x === "docker-compose"))) return fail("That's a docker compose command. Choose “A compose file” and paste the file instead.");
    return fail("Paste a command that starts with docker run.");
  }
  if (commands.length > 1) notes.push({ level: "info", text: "Only the docker run command is used; the other commands are left out." });
  let w = commands[runAt]!;

  // sudo [-E], env assignments, then docker [container] run.
  if (w[0] === "sudo") {
    w = w.slice(1);
    while (w[0]?.startsWith("-")) w = w.slice(1);
  }
  while (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
  if (w[0] && /(^|\/)(docker|podman|nerdctl)(\.exe)?$/.test(w[0])) {
    w = w.slice(1);
    // Global flags before the subcommand (docker --context x run …).
    while (w[0]?.startsWith("-")) w = w.slice(w[0]!.includes("=") || ["-D", "--debug"].includes(w[0]!) ? 1 : 2);
    if (w[0] === "container") w = w.slice(1);
  }
  w = w.slice(1); // run or create

  const svc: Record<string, unknown> = {};
  const env = new Map<string, string>();
  const labels = new Map<string, string>();
  const ports: string[] = [];
  const volumes: string[] = [];
  const networks: string[] = [];
  const lists = new Map<string, string[]>();
  const health: Record<string, unknown> = {};
  const logging: { driver?: string; options?: Record<string, string> } = {};
  const sysctls: Record<string, string> = {};
  const ulimits: Record<string, unknown> = {};
  const storage: Record<string, string> = {};
  const taken = new Set<string>();
  const placeholders: { path: string; folder: string }[] = [];
  const pending: string[] = [];
  const noted = new Set<string>();
  const once = (key: string, n: RunNote) => {
    if (noted.has(key)) return;
    noted.add(key);
    notes.push(n);
  };
  // Set from inside apply(); an object keeps TypeScript from narrowing them to their first value.
  const st: { name: string | null; gpus: Record<string, unknown> | null; tty: boolean; stdin: boolean; restart: string | null } = { name: null, gpus: null, tty: false, stdin: false, restart: null };

  const apply = (flag: string, typed: string, value: string | null) => {
    if (SILENT.has(flag)) return;
    if (UNSUPPORTED[flag]) return notes.push({ level: "warning", flag: typed, text: `${typed} ${UNSUPPORTED[flag]}` });
    const v = value ?? "";
    switch (flag) {
      case "name":
        st.name = v;
        return;
      case "rm":
        return once("rm", { level: "info", flag: typed, text: "--rm is left out: the app keeps its container so it can restart." });
      case "interactive":
        st.stdin = true;
        return;
      case "tty":
        st.tty = true;
        return;
      case "publish":
        // Ranges (8000-8010:8000-8010) are fine for compose; the form shows them as written.
        if (parsePortString(v).raw !== null && !/^[\d.:[\]a-f]+-[\d:-]+(\/(tcp|udp))?$/i.test(v)) notes.push({ level: "warning", flag: typed, text: `${typed} ${v} isn't a port mapping Gluon can read; check it under Ports.` });
        ports.push(v);
        return;
      case "publish-all":
        return notes.push({ level: "info", flag: typed, text: "-P published every port the image declares. Gluon adds the image's ports when it looks the image up; check them under Ports." });
      case "volume":
        {
          const vol = volumeFrom(v, { taken, notes, typed, placeholders, pending });
          if (vol) volumes.push(vol);
        }
        return;
      case "mount": {
        const m = mountFrom(v, { taken, notes, typed, placeholders, pending });
        if (m.tmpfs) push("tmpfs", m.tmpfs);
        else if (m.volume) volumes.push(m.volume);
        return;
      }
      case "env": {
        const eq = v.indexOf("=");
        if (eq < 0) {
          env.set(v, "");
          once(`env-${v}`, { level: "warning", flag: typed, text: `-e ${v} takes its value from your shell. Enter the value for ${v}.` });
        } else env.set(v.slice(0, eq), v.slice(eq + 1));
        return;
      }
      case "label": {
        const eq = v.indexOf("=");
        labels.set(eq < 0 ? v : v.slice(0, eq), eq < 0 ? "" : v.slice(eq + 1));
        return;
      }
      case "restart":
        if (RESTARTS.test(v)) st.restart = v;
        else notes.push({ level: "warning", flag: typed, text: `--restart ${v} isn't a restart policy; it restarts unless stopped instead.` });
        return;
      case "network":
      case "net": {
        if (v === "host") svc.network_mode = "host";
        else if (v === "none") svc.network_mode = "none";
        else if (v === "bridge" || v === "default") return;
        else if (v.startsWith("container:")) {
          svc.network_mode = v;
          notes.push({ level: "warning", flag: typed, text: `It shares the network of the container “${v.slice(10)}”, which has to be running first.` });
        } else if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) {
          networks.push(v.replace(/,.*$/, ""));
          notes.push({ level: "info", flag: typed, text: `It joins the existing network “${v}” on this server.` });
        } else notes.push({ level: "warning", flag: typed, text: `“${v}” isn't a network name Gluon can use.` });
        return;
      }
      case "network-alias":
      case "net-alias":
        return notes.push({ level: "info", flag: typed, text: `${typed} ${v} is left out. Other services in the app reach it by its service name.` });
      case "gpus":
        st.gpus = gpusFrom(v);
        return;
      case "memory":
        svc.mem_limit = v.toLowerCase();
        return;
      case "memory-reservation":
        svc.mem_reservation = v.toLowerCase();
        return;
      case "memory-swap":
        svc.memswap_limit = v === "-1" ? -1 : v.toLowerCase();
        return;
      case "cpus":
        svc.cpus = /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
        return;
      case "entrypoint":
        svc.entrypoint = v === "" ? [""] : [v];
        return;
      case "health-cmd":
        health.test = ["CMD-SHELL", v];
        return;
      case "health-interval":
        health.interval = v;
        return;
      case "health-timeout":
        health.timeout = v;
        return;
      case "health-start-period":
        health.start_period = v;
        return;
      case "health-start-interval":
        health.start_interval = v;
        return;
      case "health-retries":
        health.retries = /^\d+$/.test(v) ? Number(v) : v;
        return;
      case "no-healthcheck":
        health.disable = true;
        return;
      case "log-driver":
        logging.driver = v;
        return;
      case "log-opt": {
        const eq = v.indexOf("=");
        (logging.options ??= {})[eq < 0 ? v : v.slice(0, eq)] = eq < 0 ? "" : v.slice(eq + 1);
        return;
      }
      case "sysctl": {
        const eq = v.indexOf("=");
        sysctls[eq < 0 ? v : v.slice(0, eq)] = eq < 0 ? "" : v.slice(eq + 1);
        return;
      }
      case "ulimit": {
        const m = /^([a-z]+)=(-?\d+)(?::(-?\d+))?$/.exec(v);
        if (!m) return notes.push({ level: "warning", flag: typed, text: `--ulimit ${v} isn't a limit Gluon can read, like nofile=1024:2048.` });
        ulimits[m[1]!] = m[3] !== undefined ? { soft: Number(m[2]), hard: Number(m[3]) } : Number(m[2]);
        return;
      }
      case "storage-opt": {
        const eq = v.indexOf("=");
        storage[eq < 0 ? v : v.slice(0, eq)] = eq < 0 ? "" : v.slice(eq + 1);
        return;
      }
      case "stop-timeout":
        svc.stop_grace_period = /^\d+$/.test(v) ? `${v}s` : v;
        return;
      case "pull":
        if (["always", "missing", "never"].includes(v)) svc.pull_policy = v;
        return;
      case "privileged":
        svc.privileged = true;
        return;
      case "init":
        svc.init = true;
        return;
      case "read-only":
        svc.read_only = true;
        return;
      case "oom-kill-disable":
        svc.oom_kill_disable = true;
        return;
      case "use-api-socket":
        return notes.push({ level: "warning", flag: typed, text: "--use-api-socket gives it Docker's socket. Mount /var/run/docker.sock under Folders if it truly needs it." });
      case "link":
        push("links", v);
        return once("link", { level: "info", flag: typed, text: "--link is an old way to reach another container. Services in the same app reach each other by name." });
      case "cpuset-mems":
      case "blkio-weight":
      case "blkio-weight-device":
      case "device-read-bps":
      case "device-read-iops":
      case "device-write-bps":
      case "device-write-iops":
        return notes.push({ level: "warning", flag: typed, text: `${typed} is left out. Add it under blkio_config or cpuset in Compose if you need it.` });
    }
    if (DIRECT[flag]) {
      svc[DIRECT[flag]] = v;
      return;
    }
    if (LISTS[flag]) {
      push(LISTS[flag], v);
      return;
    }
    if (NUMBERS[flag]) {
      svc[NUMBERS[flag]] = /^-?\d+$/.test(v) ? Number(v) : v;
      return;
    }
  };
  function push(key: string, v: string) {
    const l = lists.get(key) ?? [];
    l.push(v);
    lists.set(key, l);
  }

  // Flags stop at the first word that isn't one: that's the image.
  let i = 0;
  for (; i < w.length; i++) {
    const t = w[i]!;
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-") || t === "-") break;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const flag = (eq < 0 ? t.slice(2) : t.slice(2, eq)).toLowerCase();
      const kind = LONG[flag];
      if (!kind) {
        // Unknown: take the next word as its value only when an image would still follow.
        let val: string | null = eq < 0 ? null : t.slice(eq + 1);
        if (val === null && w[i + 1] && !w[i + 1]!.startsWith("-") && w[i + 2] !== undefined) val = w[++i]!;
        unknown.push(val === null ? t : eq < 0 ? `${t} ${val}` : t);
        continue;
      }
      if (kind === "bool") {
        const val = eq < 0 ? "true" : t.slice(eq + 1).toLowerCase();
        if (val !== "false") apply(flag, `--${flag}`, null);
        continue;
      }
      const val = eq < 0 ? w[++i] : t.slice(eq + 1);
      if (val === undefined) return fail(`--${flag} needs a value, and the command ends there.`);
      apply(flag, `--${flag}`, val);
      continue;
    }
    // Short flags, possibly bundled (-dit) with a value at the end (-p8080:80, -itp 80:80).
    const chars = t.slice(1);
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j]!;
      const flag = SHORT[ch];
      if (!flag) {
        unknown.push(`-${ch}`);
        continue;
      }
      if (LONG[flag] === "bool") {
        apply(flag, `-${ch}`, null);
        continue;
      }
      let val = chars.slice(j + 1);
      if (val.startsWith("=")) val = val.slice(1);
      if (!val) {
        const next = w[++i];
        if (next === undefined) return fail(`-${ch} needs a value, and the command ends there.`);
        val = next;
      }
      apply(flag, `-${ch}`, val);
      break;
    }
  }
  const image = (w[i] ?? "").replace(new RegExp(LIT, "g"), "$");
  const args = w.slice(i + 1);
  if (!image) return fail("The command has no image. It goes after the flags, like docker run -d nginx.");
  const ie = imageError(image);
  if (ie) return fail(`“${image}” doesn't look like an image: ${ie.charAt(0).toLowerCase()}${ie.slice(1)}`);

  const slug = st.name ? slugify(st.name) : "";
  const service = slug && SERVICE_RE.test(slug) && !RESERVED_SERVICES.has(slug) ? slug : serviceNameFor(image);
  const out: Record<string, unknown> = { image };
  out.restart = st.restart ?? "unless-stopped";
  if (!st.restart) notes.push({ level: "info", text: "It restarts unless you stop it (docker run on its own never restarts)." });
  if (args.length) out.command = args;
  Object.assign(out, svc);
  if (ports.length && svc.network_mode !== "host") out.ports = ports;
  else if (ports.length) notes.push({ level: "info", text: "It uses the server's network, so its -p mappings aren't needed." });
  if (volumes.length) out.volumes = volumes;
  if (pending.length) {
    out[PENDING_KEY] = [...new Set(pending)];
    notes.push({ level: "warning", text: `${pending.length === 1 ? `${pending[0]} holds` : `${pending.join(", ")} hold`} your ${[...new Set(pending.map((p) => mediaKind(p)))].join(" and ")}, so choose ${pending.length === 1 ? "a server folder" : "server folders"} for ${pending.length === 1 ? "it" : "them"} in the next step. App data is deleted with the app.` });
  }
  if (env.size) out.environment = Object.fromEntries(env);
  if (labels.size) out.labels = Object.fromEntries(labels);
  for (const [k, v] of lists) out[k] = v;
  if (networks.length && svc.network_mode === undefined) out.networks = ["default", ...new Set(networks)];
  if (st.gpus) out.deploy = { resources: { reservations: { devices: [st.gpus] } } };
  if (Object.keys(health).length) out.healthcheck = health;
  if (logging.driver || logging.options) out.logging = logging;
  if (Object.keys(sysctls).length) out.sysctls = sysctls;
  if (Object.keys(ulimits).length) out.ulimits = ulimits;
  if (Object.keys(storage).length) out.storage_opt = storage;
  if (st.tty) out.tty = true;
  if (st.stdin) out.stdin_open = true;
  if (placeholders.length) {
    const list = placeholders.map((p) => `data/${p.folder}`).join(", ");
    notes.push({ level: "warning", flag: "-v", text: `${placeholders.length === 1 ? `${placeholders[0]!.path} is a placeholder, so it's` : `${placeholders.length} folders are placeholders (/path/to/…), so they're`} kept in the app's data folder (${list}). Point any that hold your files at real folders in the next step.` });
  }
  if (/\$\(|`/.test(JSON.stringify(out))) notes.push({ level: "warning", text: "It uses $(…) or backticks, which your shell would have run. Replace them with their values." });
  if (unknown.length) notes.push({ level: "warning", text: `Gluon doesn't know ${unknown.length === 1 ? "this flag" : "these flags"}, so ${unknown.length === 1 ? "it was" : "they were"} left out: ${unknown.join(", ")}.` });
  return { ok: true, error: null, image, containerName: st.name, service, spec: out, networks: [...new Set(networks)], notes, unknown };
}

interface VolumeCtx {
  taken: Set<string>;
  notes: RunNote[];
  typed: string;
  placeholders: { path: string; folder: string }[];
  /** Media library targets waiting for the person to choose a server folder. */
  pending: string[];
}

/**
 * -v source:target[:mode] → a compose volume. Placeholder and relative folders become app data,
 * except media libraries, which wait for a server folder (null): app data is deleted with the app.
 */
function volumeFrom(v: string, c: VolumeCtx): string | null {
  const parts = v.split(":");
  const guess = (target: string, folder: () => string, note: (f: string) => RunNote | null, suffix = ""): string | null => {
    if (mediaKind(target)) {
      c.pending.push(target);
      return null;
    }
    const f = folder();
    const n = note(f);
    if (n) c.notes.push(n);
    return `${DATA_PREFIX}${f}:${target}${suffix}`;
  };
  if (parts.length === 1) {
    // An anonymous volume would be lost on every update; keep it with the app.
    return guess(v, () => dataFolderFor(v, c.taken), (f) => ({ level: "info", flag: c.typed, text: `${v} is kept in the app's data folder (data/${f}), so it survives updates.` }));
  }
  const [source, target, ...mode] = parts as [string, string, ...string[]];
  const suffix = mode.length ? `:${mode.join(":")}` : "";
  const clean = source.replace(new RegExp(LIT, "g"), "$");
  const rel = /^(\.{1,2}(\/|$)|~(\/|$)|\$\(pwd\)|\$\{?PWD\}?|\$\{?HOME\}?)/.exec(clean);
  if (rel || clean.startsWith("$")) {
    const rest = clean.replace(/^(\$\(pwd\)|\$\{?PWD\}?|\$\{?HOME\}?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|~|\.{1,2})\/?/, "");
    return guess(target, () => (rest ? dataFolderFor(`/${rest}`, c.taken) : dataFolderFor(target, c.taken)), (f) => ({ level: "info", flag: c.typed, text: `${clean} is relative to where the command ran, so it's kept in the app's data folder as data/${f}.` }), suffix);
  }
  if (/^\/path\/to(\/|$)|^\/(your|my)[-_]|<[^>]*>/i.test(clean)) {
    return guess(
      target,
      () => dataFolderFor(clean.replace(/^\/path\/to/i, "").replace(/[<>]/g, "") || target, c.taken),
      (f) => {
        c.placeholders.push({ path: clean, folder: f });
        return null;
      },
      suffix,
    );
  }
  if (clean.startsWith("/")) return `${clean}:${target}${suffix}`;
  // A named volume: kept with the app instead, so it's backed up and removed with it.
  return guess(target, () => dataFolderFor(`/${clean}`, c.taken), (f) => ({ level: "info", flag: c.typed, text: `The Docker volume “${clean}” becomes the app data folder data/${f}, so it's kept with the app.` }), suffix);
}

/** --mount type=bind,source=/a,target=/b,readonly → a volume string, or a tmpfs path. */
function mountFrom(v: string, c: VolumeCtx): { volume?: string | null; tmpfs?: string } {
  const kv = new Map<string, string>();
  for (const part of v.split(",")) {
    const eq = part.indexOf("=");
    kv.set((eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase(), eq < 0 ? "true" : part.slice(eq + 1).trim());
  }
  const type = kv.get("type") ?? "volume";
  const target = kv.get("target") ?? kv.get("destination") ?? kv.get("dst") ?? "";
  const source = kv.get("source") ?? kv.get("src") ?? "";
  const ro = ["true", "1"].includes(kv.get("readonly") ?? kv.get("ro") ?? "");
  if (!target) {
    c.notes.push({ level: "warning", flag: c.typed, text: `--mount ${v} has no target, so it's left out.` });
    return {};
  }
  if (type === "tmpfs") {
    const size = kv.get("tmpfs-size");
    return { tmpfs: size ? `${target}:size=${size}` : target };
  }
  if (type === "bind") return { volume: volumeFrom(`${source}:${target}${ro ? ":ro" : ""}`, c) };
  if (!source) return { volume: volumeFrom(target, c) };
  return { volume: volumeFrom(`${source}:${target}${ro ? ":ro" : ""}`, c) };
}

/** --gpus all | 2 | "device=0,1" | capabilities=… → a compose device reservation. */
function gpusFrom(v: string): Record<string, unknown> {
  const out: Record<string, unknown> = { driver: "nvidia" };
  const clean = v.replace(/^["']|["']$/g, "");
  if (clean === "all") out.count = "all";
  else if (/^\d+$/.test(clean)) out.count = Number(clean);
  else {
    // CSV where a part without "=" continues the previous value: device=0,2 → two devices.
    const fields: [string, string[]][] = [];
    for (const part of clean.replace(/"/g, "").split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) fields.push([part.slice(0, eq).trim(), [part.slice(eq + 1).trim()]]);
      else if (fields.length && part.trim()) fields[fields.length - 1]![1].push(part.trim());
    }
    for (const [k, vals] of fields) {
      if (k === "device") out.device_ids = vals.filter(Boolean);
      else if (k === "count") out.count = vals[0] === "all" ? "all" : Number(vals[0]);
      else if (k === "driver") out.driver = vals[0];
      else if (k === "capabilities") out.capabilities = vals.filter(Boolean);
    }
    if (!out.device_ids && out.count === undefined) out.count = "all";
  }
  out.capabilities ??= ["gpu"];
  return out;
}

// ---------------------------------------------------------------- to compose

/** Strings as compose reads them: `$` from single quotes stays literal ($$). */
const forCompose = (v: unknown): unknown => {
  if (typeof v === "string") return v.replace(new RegExp(LIT, "g"), "$$$$");
  if (Array.isArray(v)) return v.map(forCompose);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, forCompose(x)]));
  return v;
};

export interface RunCompose {
  ok: boolean;
  error: string | null;
  compose: string;
  service: string;
  name: string | null;
  image: string;
  notes: RunNote[];
  unknown: string[];
}

/** The compose file for a docker run command. */
export function composeFromDockerRun(input: string): RunCompose {
  const r = parseDockerRun(input);
  if (!r.ok) return { ok: false, error: r.error, compose: "", service: r.service, name: null, image: "", notes: r.notes, unknown: r.unknown };
  const top: Record<string, unknown> = { services: { [r.service]: forCompose(r.spec) } };
  if (r.networks.length && Array.isArray(r.spec.networks)) top.networks = Object.fromEntries(r.networks.map((n) => [n, { external: true }]));
  const doc = new Document(top);
  // Port mappings stay strings: YAML 1.1 readers turn 22:22 into a base-60 number.
  const ports = (doc.getIn(["services", r.service, "ports"], true) ?? null) as unknown;
  if (isSeq(ports)) for (const p of ports.items) if (isScalar(p)) p.type = Scalar.QUOTE_DOUBLE;
  const envMap = doc.getIn(["services", r.service, "environment"], true) as unknown;
  if (isMap(envMap)) for (const p of (envMap as YAMLMap).items) if (isScalar(p.value) && typeof p.value.value === "string" && /^(\d+|true|false|yes|no|on|off|null)$/i.test(p.value.value)) p.value.type = Scalar.QUOTE_DOUBLE;
  const name = r.containerName ? titleize(r.containerName) : nameForImage(r.image);
  return { ok: true, error: null, compose: stringify(doc), service: r.service, name, image: r.image, notes: r.notes, unknown: r.unknown };
}

/** The New app flow's draft from a docker run command: the compose file, made ready like a pasted one. */
export function draftFromDockerRun(input: string, target: BuilderTarget): { run: RunCompose; prepared: Prepared | null } {
  const run = composeFromDockerRun(input);
  if (!run.ok) return { run, prepared: null };
  const prepared = prepareCompose(run.compose, target, "compose");
  return { run, prepared: { ...prepared, name: run.name } };
}
