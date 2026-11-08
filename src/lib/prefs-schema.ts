import { z } from "zod";
import { ONBOARDING_STATES } from "./onboarding";
import { uiBits, type UiBits } from "./prefs";

/** Per-user preferences: the schema the server validates and stores with. Client code imports @/lib/prefs, which stays free of zod. */
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

  /** "status" (a page that was removed) and anything else unknown read as Home. */
  startPage: z.enum(["home", "apps", "files"]).catch("home").default("home"),
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

export function decodeUiCookie(v: string | undefined): UiBits {
  const d = uiBits(defaultPrefs);
  if (!v) return d;
  const [theme, attention, contrast, density, textSize, motion] = v.split(".");
  const parsed = prefsSchema.pick({ theme: true, attention: true, contrast: true, density: true, textSize: true, motion: true }).safeParse({
    theme, attention, contrast, density, textSize, motion,
  });
  return parsed.success ? parsed.data : d;
}
