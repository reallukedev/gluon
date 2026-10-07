// Builds the trimmed command specs the terminal's suggestions use, from @withfig/autocomplete
// (MIT, Copyright (c) 2021 Hercules Labs Inc.). Run it after updating that package:
//   node src/lib/terminal/specs/generate.mjs
// Each program becomes one small JSON file, loaded by the browser only when that program is typed.
// Functions (generators, custom parsers) are dropped; templates (files, folders) and fixed
// suggestions are kept. journalctl and prosodyctl aren't in the package, so they're written here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const build = path.join(root, "node_modules/@withfig/autocomplete/build");

const PROGRAMS = (
  "apt dpkg docker docker-compose systemctl git ls cd cp mv rm mkdir rmdir touch cat tail head less grep find ps kill pkill killall " +
  "df du chmod chown ln tar zip unzip curl wget ssh scp rsync rclone mount lsblk fdisk ping dig traceroute nc sudo su crontab passwd id " +
  "npm node python3 pip sed sort uniq wc diff file stat tee tr cut base64 lsof jq make tmux screen which echo env uname top htop " +
  "nano vim date time tailscale sqlite3 mysql psql xargs ffmpeg nginx"
).split(" ");

const MAX_DEPTH = 5;
const MAX_DESC = 110;

const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function desc(d) {
  if (typeof d !== "string") return undefined;
  let s = d.replace(/\s+/g, " ").trim();
  const dot = s.search(/\.\s/);
  if (dot > 20) s = s.slice(0, dot);
  s = s.replace(/\.$/, "");
  if (s.length > MAX_DESC) s = `${s.slice(0, MAX_DESC - 1).trimEnd()}…`;
  return s || undefined;
}

function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || (Array.isArray(o[k]) && o[k].length === 0) || o[k] === false) delete o[k];
  return o;
}

function simpleArg(a) {
  if (!a || typeof a !== "object") return clean({});
  const templates = [...arr(a.template), ...arr(a.generators).flatMap((g) => arr(g?.template))].filter((t) => t === "filepaths" || t === "folders");
  const suggestions = arr(a.suggestions)
    .map((s) => (typeof s === "string" ? { name: s } : s && typeof s === "object" ? { name: arr(s.name)[0], description: desc(s.description) } : null))
    .filter((s) => s && typeof s.name === "string" && !s.hidden)
    .slice(0, 80)
    .map(clean);
  return clean({ name: typeof a.name === "string" ? a.name : undefined, description: desc(a.description), template: [...new Set(templates)], suggestions, variadic: !!a.isVariadic, optional: !!a.isOptional });
}

async function loadRaw(name) {
  const file = path.join(build, `${name}.js`);
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  let spec = mod.default;
  if (typeof spec === "function") spec = spec();
  return spec && typeof spec === "object" ? spec : null;
}

async function simpleNode(n, depth) {
  if (typeof n.loadSpec === "string" && depth < 2) {
    const loaded = await loadRaw(n.loadSpec);
    if (loaded) n = { ...loaded, name: n.name, description: n.description ?? loaded.description };
  }
  const out = { name: arr(n.name).filter((x) => typeof x === "string"), description: desc(n.description) };
  if (depth < MAX_DEPTH) {
    const subs = [];
    for (const s of arr(n.subcommands)) if (s && !s.hidden && arr(s.name).length) subs.push(await simpleNode(s, depth + 1));
    out.subcommands = subs;
  }
  out.options = arr(n.options)
    .filter((o) => o && !o.hidden && arr(o.name).length)
    .map((o) => clean({ name: arr(o.name).filter((x) => typeof x === "string"), description: desc(o.description), args: arr(o.args).map(simpleArg), repeatable: !!o.isRepeatable, persistent: !!o.isPersistent }));
  out.args = arr(n.args).map(simpleArg);
  return clean(out);
}

const o = (name, description, args) => ({ name: arr(name), description, ...(args ? { args: arr(args) } : {}) });
const unit = { name: "unit" };

const LOCAL = {
  journalctl: {
    name: ["journalctl"],
    description: "Show the systemd journal",
    options: [
      o(["-u", "--unit"], "Show messages from this unit", unit),
      o(["-f", "--follow"], "Keep showing new messages as they arrive"),
      o(["-n", "--lines"], "How many recent lines to show", { name: "lines", suggestions: [{ name: "50" }, { name: "200" }, { name: "1000" }] }),
      o(["-e", "--pager-end"], "Jump to the end"),
      o(["-r", "--reverse"], "Newest first"),
      o(["-b", "--boot"], "Only this boot (or -b -1 for the one before)"),
      o(["-k", "--dmesg"], "Kernel messages only"),
      o(["-p", "--priority"], "Only this priority or worse", { name: "priority", suggestions: ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"].map((name) => ({ name })) }),
      o(["-S", "--since"], "Start at this time", { name: "time", suggestions: [{ name: "today" }, { name: "yesterday" }, { name: "-1h" }, { name: "-10min" }] }),
      o(["-U", "--until"], "Stop at this time", { name: "time" }),
      o(["-o", "--output"], "Output format", { name: "format", suggestions: ["short", "short-iso", "verbose", "json", "json-pretty", "cat"].map((name) => ({ name })) }),
      o(["-x", "--catalog"], "Add explanations to messages"),
      o(["-g", "--grep"], "Only messages matching this pattern", { name: "pattern" }),
      o("--no-pager", "Print everything instead of paging"),
      o("--disk-usage", "How much space the journal uses"),
      o("--vacuum-size", "Shrink the journal to this size", { name: "size", suggestions: [{ name: "500M" }, { name: "1G" }] }),
      o("--vacuum-time", "Delete entries older than this", { name: "time", suggestions: [{ name: "2weeks" }, { name: "1month" }] }),
      o("--list-boots", "List the boots in the journal"),
    ],
  },
  prosodyctl: {
    name: ["prosodyctl"],
    description: "Manage the Prosody chat server",
    subcommands: [
      ["about", "Versions, paths and modules"],
      ["check", "Check the configuration, DNS and certificates"],
      ["status", "Is Prosody running"],
      ["reload", "Reload the configuration"],
      ["restart", "Restart Prosody"],
      ["start", "Start Prosody"],
      ["stop", "Stop Prosody"],
      ["adduser", "Create an account (asks for its password)"],
      ["passwd", "Change an account's password"],
      ["deluser", "Delete an account"],
      ["register", "Create an account with a password given on the line"],
      ["unregister", "Delete an account"],
      ["shell", "Open Prosody's admin console"],
      ["cert", "Import or check certificates"],
      ["install", "Install a community module"],
      ["remove", "Remove a community module"],
      ["list", "List installed community modules"],
      ["version", "Prosody's version"],
    ].map(([name, description]) => ({ name: [name], description })),
    options: [o("--config", "Use this config file", { name: "file", template: ["filepaths"] }), o("--help", "Show help")],
  },
};

function writeJson(name, data) {
  const json = JSON.stringify(clean(data));
  fs.writeFileSync(path.join(here, `${name}.json`), `${json}\n`);
  return json.length;
}

let total = 0;
const names = [];
for (const name of PROGRAMS) {
  const raw = await loadRaw(name);
  if (!raw) {
    console.warn(`skipped ${name}: no spec`);
    continue;
  }
  const node = await simpleNode(raw, 0);
  node.name = [name];
  total += writeJson(name, node);
  names.push(name);
}
for (const [name, spec] of Object.entries(LOCAL)) {
  total += writeJson(name, spec);
  names.push(name);
}
names.sort();

const lines = names.map((n) => `  ${JSON.stringify(n)}: () => import("./${n}.json"),`);
fs.writeFileSync(
  path.join(here, "index.ts"),
  `// Generated by generate.mjs from @withfig/autocomplete (MIT, Copyright (c) 2021 Hercules Labs Inc.). Don't edit by hand.
import type { SpecNode } from "../types";

type Loader = () => Promise<{ default: unknown }>;

const SPECS: Record<string, Loader> = {
${lines.join("\n")}
};

export const knownSpecs = Object.keys(SPECS);

/** The spec for a program, fetched only when it's first typed. */
export async function loadSpec(program: string): Promise<SpecNode | null> {
  const load = Object.hasOwn(SPECS, program) ? SPECS[program] : undefined;
  if (!load) return null;
  try {
    return (await load()).default as SpecNode;
  } catch {
    return null;
  }
}
`,
);
console.log(`${names.length} specs, ${(total / 1024).toFixed(0)} KB`);
