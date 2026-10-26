import { parse, type HTMLElement } from "node-html-parser";

/**
 * Reading an AT&T BGW gateway's admin pages (BGW320, BGW210): the forms a browser would submit and
 * the tables of custom services and forwards. Pure: HTML in, plain data out. Firmware versions
 * differ in names and buttons (Remove_<n> on some, Edit/Delete on others), so everything is found
 * by what it is (a select offering TCP and UDP, a column called Protocol) rather than by one name.
 */

export interface Button {
  name: string;
  value: string;
}
export interface Field {
  name: string;
  type: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  /** The page's own limit on what can be typed, when it sets one. */
  maxLength: number | null;
}
export interface Select {
  name: string;
  options: { value: string; label: string; selected: boolean }[];
  disabled: boolean;
}
export interface Form {
  action: string;
  nonces: string[];
  /** Data fields in page order (hidden and text inputs, checkboxes), nonce excluded. */
  fields: Field[];
  selects: Select[];
  buttons: Button[];
}
export interface Row {
  cells: string[];
  buttons: Button[];
}
export interface Table {
  headers: string[];
  rows: Row[];
}
export interface Page {
  forms: Form[];
  tables: Table[];
  login: boolean;
  sessionsFull: boolean;
}

const text = (el: HTMLElement) => el.textContent.replace(/ /g, " ").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function buttonsIn(el: HTMLElement): Button[] {
  const out: Button[] = [];
  for (const b of el.querySelectorAll("input, button")) {
    const tag = b.tagName.toLowerCase();
    const type = (b.getAttribute("type") ?? (tag === "button" ? "submit" : "text")).toLowerCase();
    if (type !== "submit" && type !== "button" && type !== "image") continue;
    const name = b.getAttribute("name") ?? "";
    const value = b.getAttribute("value") ?? (tag === "button" ? text(b) : "");
    if (name || value) out.push({ name, value });
  }
  return out;
}

export function parsePage(html: string): Page {
  const root = parse(html, { comment: false });
  const forms: Form[] = root.querySelectorAll("form").map((f) => {
    const fields: Field[] = [];
    const nonces: string[] = [];
    for (const i of f.querySelectorAll("input")) {
      const type = (i.getAttribute("type") ?? "text").toLowerCase();
      const name = i.getAttribute("name") ?? "";
      if (!name || ["submit", "button", "image", "reset"].includes(type)) continue;
      const value = i.getAttribute("value") ?? "";
      if (name === "nonce") {
        nonces.push(value);
        continue;
      }
      if (name === "hashpassword") continue;
      const max = Number(i.getAttribute("maxlength"));
      fields.push({ name, type, value, checked: i.hasAttribute("checked"), disabled: i.hasAttribute("disabled"), maxLength: Number.isInteger(max) && max > 0 ? max : null });
    }
    const selects: Select[] = f.querySelectorAll("select").map((s) => {
      const options = s.querySelectorAll("option").map((o) => ({ value: o.getAttribute("value") ?? text(o), label: text(o), selected: o.hasAttribute("selected") }));
      return { name: s.getAttribute("name") ?? "", options, disabled: s.hasAttribute("disabled") };
    });
    return { action: f.getAttribute("action") ?? "", nonces, fields, selects, buttons: buttonsIn(f) };
  });

  const tables: Table[] = [];
  for (const t of root.querySelectorAll("table")) {
    // Only rows that belong to this table, not to a table nested inside it.
    const rows = t.querySelectorAll("tr").filter((r) => r.closest("table") === t);
    if (!rows.length) continue;
    const head = rows.find((r) => r.querySelectorAll("th").length > 0 && r.querySelectorAll("td").length === 0);
    const headers = head ? head.querySelectorAll("th").map(text) : [];
    const body = rows.filter((r) => r !== head && r.querySelectorAll("td").length > 0);
    tables.push({ headers, rows: body.map((r) => ({ cells: r.querySelectorAll("td").map(text), buttons: buttonsIn(r) })) });
  }

  const loginForm = forms.some((f) => /login\.ha$/i.test(f.action));
  return {
    forms,
    tables,
    login: loginForm || /Access Code Required/i.test(html),
    sessionsFull: /all web server sessions are in use/i.test(html),
  };
}

// ---------------------------------------------------------------- what the pages hold

export type Protocol = "tcp" | "udp" | "both";

export interface RouterService {
  name: string;
  min: number;
  max: number;
  /** The port on the device the range starts at. */
  hostPort: number;
  protocol: Protocol;
  remove: Button | null;
}

export interface RouterForward {
  service: string;
  /** How the router names the device ("homeserver", "192.168.1.230", a MAC). */
  device: string;
  /** The public ports, when the table shows them ("TCP/UDP: 80", one line per range). */
  ports: { min: number; max: number; protocol: Protocol }[];
  remove: Button | null;
}

export function protocolOf(s: string): Protocol | null {
  const t = s.toLowerCase().replace(/\s/g, "");
  if (t === "both" || t === "tcp/udp" || t === "udp/tcp" || t === "tcpudp" || t === "all") return "both";
  if (t === "tcp") return "tcp";
  if (t === "udp") return "udp";
  return null;
}

const col = (headers: string[], ...want: string[]) => headers.findIndex((h) => want.some((w) => norm(h).includes(w)));
const removeOf = (r: Row) => r.buttons.find((b) => /delete|remove/i.test(b.value) || /^(delete|remove)/i.test(b.name)) ?? null;

/** Custom Services: the list (name, global port range, protocol, host port). */
export function readServices(page: Page): RouterService[] {
  const t = page.tables.find((x) => col(x.headers, "protocol") >= 0 && col(x.headers, "portrange", "globalport", "port") >= 0 && col(x.headers, "name", "service") >= 0);
  if (!t) return [];
  const iName = col(t.headers, "name", "service");
  const iRange = col(t.headers, "globalportrange", "portrange", "globalport");
  const iProto = col(t.headers, "protocol");
  const iHost = col(t.headers, "hostport", "baseport", "basehost");
  const out: RouterService[] = [];
  for (const r of t.rows) {
    const name = r.cells[iName]?.trim();
    const range = r.cells[iRange]?.match(/(\d+)\s*(?:-\s*(\d+))?/);
    const protocol = protocolOf(r.cells[iProto] ?? "");
    if (!name || !range || !protocol) continue;
    const min = Number(range[1]);
    const max = Number(range[2] ?? range[1]);
    const host = iHost >= 0 ? Number(r.cells[iHost]?.match(/\d+/)?.[0] ?? min) : min;
    out.push({ name, min, max, hostPort: host, protocol, remove: removeOf(r) });
  }
  return out;
}

/** NAT/Gaming: which services are forwarded to which device. */
export function readForwards(page: Page): RouterForward[] {
  const t = page.tables.find((x) => col(x.headers, "service", "application") >= 0 && col(x.headers, "device", "neededby", "host") >= 0);
  if (!t) return [];
  const iSvc = col(t.headers, "service", "application");
  const iDev = col(t.headers, "device", "neededby", "host");
  const iPorts = col(t.headers, "port");
  const portsOf = (cell = "") =>
    [...cell.matchAll(/(TCP\s*\/\s*UDP|TCP|UDP)\s*:\s*(\d+)(?:\s*-\s*(\d+))?/gi)].map((m) => ({ min: Number(m[2]), max: Number(m[3] ?? m[2]), protocol: protocolOf(m[1]!)! }));
  return t.rows
    .map((r) => ({ service: (r.cells[iSvc] ?? "").replace(/^\*/, "").trim(), device: (r.cells[iDev] ?? "").trim(), ports: iPorts >= 0 ? portsOf(r.cells[iPorts]) : [], remove: removeOf(r) }))
    .filter((f) => f.service && f.device);
}

// ---------------------------------------------------------------- the forms that change them

export interface ServiceForm {
  form: Form;
  name: string;
  min: string;
  max: string;
  hostPort: string;
  protocol: Select;
  add: Button;
}

/** The Add form on Custom Services: the one with a protocol select offering TCP and UDP. */
export function serviceForm(page: Page): ServiceForm | null {
  for (const form of page.forms) {
    const protocol = form.selects.find((s) => s.options.some((o) => protocolOf(o.label) === "tcp" || o.value.toLowerCase() === "tcp") && s.options.some((o) => protocolOf(o.label) === "udp" || o.value.toLowerCase() === "udp"));
    const add = form.buttons.find((b) => /^add$/i.test(b.value) || /^add$/i.test(b.name));
    if (!protocol || !add) continue;
    const texts = form.fields.filter((f) => f.type === "text" || f.type === "number" || f.type === "");
    const by = (re: RegExp) => texts.find((f) => re.test(norm(f.name)))?.name;
    // Names seen in the wild first; otherwise the page's order: name, range start, range end, host port.
    const name = by(/^(service|servicename|name)$/) ?? texts[0]?.name;
    const min = by(/(extmin|minport|portstart|globalmin|fromport)/) ?? texts[1]?.name;
    const max = by(/(extmax|maxport|portend|globalmax|toport)/) ?? texts[2]?.name;
    const hostPort = by(/(intstart|baseport|basehost|hostport|internal)/) ?? texts[3]?.name;
    if (!name || !min || !max || !hostPort) continue;
    return { form, name, min, max, hostPort, protocol, add };
  }
  return null;
}

/** The value the protocol select wants (values differ from labels: "both" is shown as "TCP/UDP"). */
export function protocolOption(sel: Select, want: Protocol): string | null {
  const o = sel.options.find((x) => protocolOf(x.value) === want) ?? sel.options.find((x) => protocolOf(x.label) === want);
  return o ? o.value : null;
}

export interface ForwardForm {
  form: Form;
  service: Select;
  device: Select;
  add: Button;
}

const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/** The Add form on NAT/Gaming: a service select and a device select (options keyed by MAC). */
export function forwardForm(page: Page): ForwardForm | null {
  for (const form of page.forms) {
    const device = form.selects.find((s) => s.options.some((o) => MAC.test(o.value)));
    const service = form.selects.find((s) => s !== device && s.options.length > 0 && !s.options.some((o) => MAC.test(o.value)));
    const add = form.buttons.find((b) => /^add$/i.test(b.value) || /^add$/i.test(b.name));
    if (device && service && add) return { form, service, device, add };
  }
  return null;
}

/** The service dropdown lists custom services as "*Name". */
export function serviceOption(sel: Select, name: string): string | null {
  const o = sel.options.find((x) => x.label === name || x.value === name || x.label === `*${name}` || x.value === `*${name}`);
  return o ? o.value : null;
}

export function deviceOption(sel: Select, mac: string): { value: string; label: string } | null {
  const o = sel.options.find((x) => x.value.toLowerCase().replace(/-/g, ":") === mac.toLowerCase());
  return o ? { value: o.value, label: o.label } : null;
}

/**
 * What a browser would post for this form, as rendered, with some fields changed and one button
 * pressed: data fields, checked boxes, selects' chosen options, then the form's nonces.
 */
export function formPayload(form: Form, changes: Record<string, string>, pressed: Button): [string, string][] {
  const out: [string, string][] = [];
  for (const f of form.fields) {
    if (f.disabled) continue;
    if ((f.type === "checkbox" || f.type === "radio") && !f.checked) continue;
    out.push([f.name, changes[f.name] ?? f.value]);
  }
  for (const s of form.selects) {
    if (s.disabled || !s.name) continue;
    const chosen = s.options.find((o) => o.selected) ?? s.options[0];
    out.push([s.name, changes[s.name] ?? chosen?.value ?? ""]);
  }
  for (const [k, v] of Object.entries(changes)) if (!out.some(([n]) => n === k)) out.push([k, v]);
  if (pressed.name) out.push([pressed.name, pressed.value || pressed.name]);
  for (const n of form.nonces) out.push(["nonce", n]);
  return out;
}

/** The page's own form (the one that posts back to `<page>.ha`), which tells a real page from a stand-in. */
export function ownForm(page: Page, name: string): Form | null {
  return page.forms.find((f) => new RegExp(`(^|/)${name}\\.ha(\\?|$)`, "i").test(f.action)) ?? null;
}

/**
 * The plain restart on Restart Device (restart.ha) or Resets (reset.ha): a button named exactly
 * "Restart" showing "Restart" or "Restart Device". Its neighbours on Resets ("Reset", "WReset",
 * "FReset", "ResetIP", "ResetConn") wipe settings, so nothing else is ever matched.
 */
export function restartButton(page: Page): { form: Form; button: Button } | null {
  for (const form of page.forms) {
    if (!/(^|\/)(restart|reset)\.ha(\?|$)/i.test(form.action)) continue;
    const button = form.buttons.find((b) => b.name === "Restart" && /^restart( device)?$/i.test(b.value.trim()));
    if (button) return { form, button };
  }
  return null;
}
