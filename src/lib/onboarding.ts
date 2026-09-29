/**
 * First run (/welcome). Shared by the server (which steps apply to whom, where to resume) and the
 * client (the flow itself). No server imports.
 *
 * Progress lives in prefs.onboarding: "pending" (not started), a step id (resume there), or "done".
 */

export const ADMIN_STEPS = ["found", "updates", "notify", "people", "security", "summary"] as const;
export const MEMBER_STEPS = ["hello", "apps", "ready"] as const;

export type AdminStep = (typeof ADMIN_STEPS)[number];
export type MemberStep = (typeof MEMBER_STEPS)[number];
export type StepId = AdminStep | MemberStep;

export const ONBOARDING_STATES = ["pending", "done", ...ADMIN_STEPS, ...MEMBER_STEPS] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/** Short names for the progress line and the page title. */
export const STEP_LABEL: Record<StepId, string> = {
  found: "What's here",
  updates: "Updates",
  notify: "Alerts",
  people: "Household",
  security: "Sign-in",
  summary: "Done",
  hello: "Welcome",
  apps: "Your apps",
  ready: "Done",
};

/** Where a flow picks up: the saved step when it still applies, else the next one that does. */
export function resumeAt(saved: OnboardingState, steps: readonly StepId[]): StepId {
  const first = steps[0]!;
  if (saved === "pending" || saved === "done") return first;
  if (steps.includes(saved)) return saved;
  const order: readonly StepId[] = (ADMIN_STEPS as readonly StepId[]).includes(saved) ? ADMIN_STEPS : MEMBER_STEPS;
  const after = order.slice(order.indexOf(saved) + 1).find((s) => steps.includes(s));
  return after ?? first;
}

// ---------------------------------------------------------------- what the page starts with

export interface AdminPlan {
  role: "admin";
  steps: AdminStep[];
  start: AdminStep;
  serverName: string;
  /** How this admin reaches Gluon, and whether Gluon is published to the internet. */
  reach: { zone: "home" | "away"; publicAt: string | null };
  /** Admins signing in from outside home must use two-step (Settings → Server). */
  requireMfaAway: boolean;
  mfa: boolean;
}

export interface MemberPlan {
  role: "member";
  steps: MemberStep[];
  start: MemberStep;
  serverName: string;
  /** Who made the invite, else the first admin: the person to tell when something breaks. */
  admin: string | null;
  invitedBy: string | null;
  /** Members can open Status (and report problems from it). */
  canSeeStatus: boolean;
}

export type Plan = AdminPlan | MemberPlan;

// ---------------------------------------------------------------- first-look inventory (admin)

export type InventoryPart = "apps" | "drives" | "addresses" | "attention";

export interface InventoryApps {
  total: number;
  running: number;
  /** How the apps were installed. */
  sources: { umbrel: number; casaos: number; compose: number; docker: number };
  /** The platform Gluon works alongside ("Umbrel", "CasaOS" or "Docker"). */
  platform: string;
  /** Up to 12, running ones with icons first. */
  sample: { id: string; name: string; icon: string | null }[];
}

export interface InventoryDrives {
  disks: { id: string; title: string; summary: string; system: boolean }[];
  warnings: string[];
}

export interface InventoryAddresses {
  /** False when there's no routes.json to read (no proxy set up for Gluon to manage). */
  configured: boolean;
  count: number;
  sample: { name: string; url: string }[];
  /** Gluon's own public address, if it has one. */
  gluon: string | null;
}

export interface InventoryAttention {
  fault: number;
  attention: number;
  top: { id: string; title: string; severity: "fault" | "attention" | "info" }[];
}

// ---------------------------------------------------------------- the last admin screen

export interface OnboardingSummary {
  updates: { touched: boolean; channel: "stable" | "nightly"; auto: boolean; hour: number; nightlyTiming: "asap" | "hour" } | null;
  alerts: { name: string; kind: string }[];
  invites: { waiting: { name: string | null; role: "admin" | "member"; expiresAt: number }[]; joined: { name: string; role: "admin" | "member" }[] } | null;
  mfa: boolean;
}
