import { z } from "zod";
import { ONBOARDING_STATES } from "./onboarding";

/** Per-user preferences. Shared by server (validation, persistence) and client (settings UI). */
export const prefsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  attention: z.enum(["sodium", "orange", "magenta", "cyan"]).default("sodium"),
  contrast: z.enum(["standard", "more"]).default("standard"),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  textSize: z.enum(["small", "default", "large"]).default("default"),
  motion: z.enum(["system", "reduce"]).default("system"),

  clock: z.enum(["auto", "12", "24"]).default("auto"),
  dateOrder: z.enum(["auto", "dmy", "mdy", "ymd"]).default("auto"),
  weekStart: z.enum(["auto", "mon", "sun"]).default("auto"),
  timezone: z.string().max(64).default("auto"),
  bytes: z.enum(["decimal", "binary"]).default("decimal"),
  temperature: z.enum(["c", "f"]).default("c"),
  rates: z.enum(["bytes", "bits"]).default("bytes"),

  startPage: z.enum(["home", "status", "apps", "files"]).default("home"),
  searchEngine: z.enum(["duckduckgo", "google", "kagi", "brave", "startpage", "bing", "custom"]).default("duckduckgo"),
  searchCustomUrl: z.string().max(400).default(""),
  openLinks: z.enum(["new", "same"]).default("new"),
  greeting: z.boolean().default(true),
  greetingName: z.string().max(40).default(""),
  homeWidth: z.enum(["comfortable", "wide", "full"]).default("wide"),
  /**
   * The apps pinned to Home, in order: the Apps widget shows exactly these. null = never chosen (an
   * account from before pins, or brand new); the widget then pins what it used to show, once.
   */
  homeApps: z.array(z.string().max(200)).max(80).nullable().catch(null).default(null),

  sidebarOrder: z.array(z.string().max(40)).max(40).default([]),
  sidebarHidden: z.array(z.string().max(40)).max(40).default([]),
  sidebarCollapsed: z.boolean().default(false),
  /**
   * First run (/welcome): "pending" until it starts, then the step to resume at, then "done". Accounts
   * from before first run existed have no value and read as "done". An unknown step (renamed in a
   * later version) starts the flow again rather than breaking the rest of the prefs.
   */
  onboarding: z.enum(ONBOARDING_STATES).catch("pending").default("done"),

  shortcuts: z.boolean().default(true),
  filesView: z.enum(["list", "grid"]).default("list"),
  filesShowHidden: z.boolean().default(false),
  filesSort: z.enum(["name", "modified", "size", "kind"]).default("name"),
  logsWrap: z.boolean().default(true),
  logsTimestamps: z.boolean().default(true),
});

export type Prefs = z.infer<typeof prefsSchema>;
export const defaultPrefs: Prefs = prefsSchema.parse({});

/** The subset mirrored into a cookie so the server can render the right theme without a flash. */
export const UI_COOKIE = "gluon_ui";
export type UiBits = Pick<Prefs, "theme" | "attention" | "contrast" | "density" | "textSize" | "motion">;
export function uiBits(p: Prefs): UiBits {
  return { theme: p.theme, attention: p.attention, contrast: p.contrast, density: p.density, textSize: p.textSize, motion: p.motion };
}
export function encodeUiCookie(b: UiBits): string {
  return [b.theme, b.attention, b.contrast, b.density, b.textSize, b.motion].join(".");
}
export function decodeUiCookie(v: string | undefined): UiBits {
  const d = uiBits(defaultPrefs);
  if (!v) return d;
  const [theme, attention, contrast, density, textSize, motion] = v.split(".");
  const parsed = prefsSchema.pick({ theme: true, attention: true, contrast: true, density: true, textSize: true, motion: true }).safeParse({
    theme, attention, contrast, density, textSize, motion,
  });
  return parsed.success ? parsed.data : d;
}

/** html data-attributes for the UI bits. */
export function htmlAttrs(b: UiBits): Record<string, string> {
  return {
    "data-theme": b.theme,
    "data-attn": b.attention,
    "data-contrast": b.contrast,
    "data-density": b.density,
    "data-text": b.textSize,
    "data-motion": b.motion,
  };
}

export const SEARCH_ENGINES: Record<Exclude<Prefs["searchEngine"], "custom">, { name: string; url: string }> = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  google: { name: "Google", url: "https://www.google.com/search?q=%s" },
  kagi: { name: "Kagi", url: "https://kagi.com/search?q=%s" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=%s" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
};
