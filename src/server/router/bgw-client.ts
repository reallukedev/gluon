import "server-only";
import crypto from "node:crypto";
import { AppError } from "../errors";
import { parsePage, type Button, type Form, type Page, formPayload } from "./bgw-pages";

/**
 * A browser for an AT&T BGW gateway's admin pages, written to be a good guest on a slow box with
 * a handful of web sessions and no logout:
 *
 * - One thing talks to the gateway at a time (`withRouter` queues everything per gateway).
 * - Every visit without a cookie costs the gateway a session, so cookies are always kept: one
 *   jar for the pages anyone can read, a second only for signing in with the access code, so
 *   Gluon's routine reads never keep a signed-in session alive.
 * - Pages take up to 40 seconds to answer, so timeouts are generous and named.
 * - The sign-in is the page's own: GET login.ha sets the session cookie, a second GET shows the
 *   form and its nonce, and the POST carries md5(access code + nonce) as "hashpassword" (the code
 *   itself never leaves Gluon; "password" is asterisks, as the page's script sends it).
 */

type Jar = Map<string, string>;
interface Gateway {
  origin: string;
  /** Cookies for the pages that need no sign-in. */
  open: Jar;
  /** Cookies for the signed-in session. */
  auth: Jar;
  loggedIn: boolean;
  busy: Promise<unknown>;
}

type G = typeof globalThis & { __gluonBgw?: Map<string, Gateway> };
const g = globalThis as G;
const gateways = () => (g.__gluonBgw ??= new Map());

function gatewayFor(address: string): Gateway {
  const origin = `http://${address}`;
  let s = gateways().get(origin);
  if (!s) {
    s = { origin, open: new Map(), auth: new Map(), loggedIn: false, busy: Promise.resolve() };
    gateways().set(origin, s);
  }
  return s;
}

/** Long enough for the slowest page seen (Home Network Status, about 40 s). */
export const PAGE_TIMEOUT_MS = 50_000;

const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const where = (s: Gateway) => s.origin.slice(7);

export interface Answer {
  status: number;
  html: string;
  location: string | null;
}

async function request(s: Gateway, jar: Jar, path: string, init: { method?: "GET" | "POST"; body?: string; referer?: string; timeoutMs?: number } = {}, hops = 0): Promise<Answer> {
  let res: Response;
  const timeoutMs = init.timeoutMs ?? PAGE_TIMEOUT_MS;
  try {
    res = await fetch(`${s.origin}${path}`, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        ...(jar.size ? { Cookie: cookieHeader(jar) } : {}),
        ...(init.body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded", Origin: s.origin } : {}),
        ...(init.referer ? { Referer: `${s.origin}${init.referer}` } : {}),
      },
      body: init.body,
      // Never a cached answer: Next keeps fetch results between renders in development.
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new AppError("router_slow", `Your router at ${where(s)} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`, 504);
    throw new AppError("router_unreachable", `Gluon couldn't reach your router at ${where(s)}.`, 502);
  }
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair!.indexOf("=");
    if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
  }
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location && hops < 5) {
    // A POST's redirect is the answer; a GET follows it like a browser would.
    if (init.method === "POST") return { status: res.status, html: await res.text().catch(() => ""), location };
    const next = location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location;
    return request(s, jar, next, { timeoutMs }, hops + 1);
  }
  return { status: res.status, html: await res.text(), location };
}

const busyError = () => new AppError("router_busy", "Your router has too many web sessions open right now (it allows only a few). Close its settings page in other browsers, or wait about 10 minutes, then try again.", 503);

async function login(s: Gateway, code: string): Promise<void> {
  s.loggedIn = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    // The first visit only sets the session cookie ("Cookies must be enabled"); the form comes after.
    const page = parsePage((await request(s, s.auth, "/cgi-bin/login.ha")).html);
    if (page.sessionsFull) throw busyError();
    const form = page.forms.find((f) => /login\.ha$/i.test(f.action));
    const nonce = form?.nonces[0];
    if (!form || !nonce) {
      if (attempt === 1) s.auth.clear();
      continue;
    }
    const hash = crypto.createHash("md5").update(`${code}${nonce}`, "utf8").digest("hex");
    const body = new URLSearchParams({ nonce, password: "*".repeat(code.length), hashpassword: hash, Continue: "Continue" }).toString();
    const res = await request(s, s.auth, "/cgi-bin/login.ha", { method: "POST", body, referer: "/cgi-bin/login.ha" });
    if (parsePage(res.html).sessionsFull) throw busyError();
    if (res.status >= 300 && res.status < 400 && !/login\.ha/i.test(res.location ?? "")) {
      s.loggedIn = true;
      return;
    }
    // Some firmware answers with a plain page either way: a protected page settles it.
    const probe = parsePage((await request(s, s.auth, "/cgi-bin/apphosting.ha")).html);
    if (probe.sessionsFull) throw busyError();
    if (!probe.login) {
      s.loggedIn = true;
      return;
    }
    throw new AppError("router_code", "Your router didn't accept that access code. It's the Device Access Code printed on the router's label.", 400, { field: "code" });
  }
  throw new AppError("router_login", "Your router didn't show its sign-in form. Try again in a minute.", 502);
}

/** Run `fn` with the gateway to ourselves: two things at once confuse its nonces and sessions. */
export function withRouter<T>(address: string, code: string | null, fn: (r: RouterPages) => Promise<T>): Promise<T> {
  const s = gatewayFor(address);
  const run = s.busy.then(() => fn(new RouterPages(s, code)));
  s.busy = run.catch(() => undefined);
  return run;
}

export class RouterPages {
  constructor(
    private s: Gateway,
    private code: string | null,
  ) {}

  /** The router's address, as Gluon reaches it. */
  get gateway() {
    return this.s.origin.slice(7);
  }

  /**
   * Sign in with this code from here on. For a stored code, read it once the queue reaches this
   * job, so a code entered while it waited is the one used.
   */
  useCode(code: string) {
    if (code !== this.code) this.s.loggedIn = false;
    this.code = code;
  }

  /** A page anyone on the network can open. No sign-in, and never the signed-in session. */
  async read(page: string, timeoutMs?: number): Promise<string> {
    const res = await request(this.s, this.s.open, `/cgi-bin/${page}.ha`, { timeoutMs });
    if (res.status >= 400) throw new AppError("router_page", `Your router answered ${res.status} for its ${page} page.`, 502);
    if (/all web server sessions are in use/i.test(res.html)) throw busyError();
    return res.html;
  }

  /** A page behind the access code, signing in when the gateway asks for it. */
  async get(page: string): Promise<{ page: Page; html: string }> {
    if (!this.code) throw new AppError("router_not_connected", "Connect Gluon to your router first.", 409);
    if (!this.s.loggedIn) await login(this.s, this.code);
    let res = await request(this.s, this.s.auth, `/cgi-bin/${page}.ha`);
    let parsed = parsePage(res.html);
    if (parsed.sessionsFull) throw busyError();
    if (parsed.login) {
      await login(this.s, this.code);
      res = await request(this.s, this.s.auth, `/cgi-bin/${page}.ha`);
      parsed = parsePage(res.html);
      if (parsed.login) throw new AppError("router_login", "Your router keeps asking Gluon to sign in. Check the access code under Network, Port forwarding.", 502);
    }
    return { page: parsed, html: res.html };
  }

  /**
   * Submit `form` (as read from `page` just now) with some fields changed and one button pressed.
   * `drops` is for a button that takes the router's web server down with it (a restart): no
   * answer is the expected answer.
   */
  async submit(page: string, form: Form, changes: Record<string, string>, pressed: Button, opts: { drops?: boolean } = {}): Promise<Answer | null> {
    const action = form.action ? (form.action.startsWith("/") ? form.action : `/cgi-bin/${form.action}`) : `/cgi-bin/${page}.ha`;
    const body = new URLSearchParams(formPayload(form, changes, pressed)).toString();
    let res: Answer;
    try {
      res = await request(this.s, this.s.auth, action, { method: "POST", body, referer: `/cgi-bin/${page}.ha`, timeoutMs: opts.drops ? 20_000 : undefined });
    } catch (e) {
      if (opts.drops && e instanceof AppError && (e.code === "router_slow" || e.code === "router_unreachable")) {
        this.s.loggedIn = false;
        return null;
      }
      throw e;
    }
    const answer = parsePage(res.html);
    if (answer.sessionsFull) throw busyError();
    if (answer.login) {
      this.s.loggedIn = false;
      throw new AppError("router_login", "Your router signed Gluon out in the middle of a change. Nothing was changed; try again.", 502);
    }
    if (res.status >= 400) throw new AppError("router_rejected", `Your router refused the change (it answered ${res.status}).`, 502);
    if (opts.drops) this.s.loggedIn = false;
    return res;
  }
}

/**
 * Sign in again before the next protected page (the code changed or was removed). The cookie is
 * kept, so the next sign-in reuses the router's session instead of taking another.
 */
export function signOut(address: string) {
  const s = gateways().get(`http://${address}`);
  if (s) s.loggedIn = false;
}

export type Identity = { kind: "bgw"; model: string; firmware: string | null; html: string } | { kind: "other"; name: string | null } | { kind: "unreachable" };

/** Is there an AT&T BGW gateway at this address? Reads System Information, no sign-in. */
export async function identify(address: string): Promise<Identity> {
  return withRouter(address, null, async (r) => {
    let html: string;
    try {
      html = await r.read("sysinfo", 15_000);
    } catch (e) {
      if (e instanceof AppError && e.code === "router_page") return { kind: "other", name: null };
      if (e instanceof AppError && e.code === "router_busy") throw e;
      return { kind: "unreachable" };
    }
    const cell = (label: string) => html.match(new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([^<]*)`, "i"))?.[1]?.trim() || null;
    const model = cell("Model Number");
    if (!model || !/^BGW/i.test(model)) return { kind: "other", name: html.match(/<title>([^<]{1,60})<\/title>/i)?.[1]?.trim() ?? null };
    return { kind: "bgw", model: `${cell("Manufacturer") ? `${cell("Manufacturer")} ` : ""}${model}`.trim(), firmware: cell("Software Version"), html };
  });
}
