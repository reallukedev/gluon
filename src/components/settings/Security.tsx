"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { api, useApi, ApiError } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Panel, Notice, Skeleton } from "@/components/ui/Surface";
import { Field, Input, SettingRow, Checkbox } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { StateLine } from "@/components/ui/StateLine";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { PasswordStrength } from "@/components/auth/PasswordStrength";
import { RecoveryCodes } from "@/components/auth/RecoveryCodes";
import { TwoStepSetup, type Enrolment } from "@/components/auth/TwoStepSetup";
import { clock, retryAfterOf, useCountdown } from "@/components/auth/useCountdown";
import s from "./security.module.css";

interface SessionRow {
  id: string;
  current: boolean;
  sameDevice: boolean;
  newDevice: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  zone: "home" | "away";
  userAgent: string | null;
}

interface MfaStatus {
  enabled: boolean;
  recoveryLeft: number;
  requiredAway: boolean;
  zone: "home" | "away";
}

const DAY = 86_400_000;

function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /curl|wget|python|node|okhttp|go-http/i.test(ua)
            ? "Script"
            : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function Security() {
  const { data: mfa, mutate: refreshMfa } = useApi<MfaStatus>("/api/me/mfa");
  return (
    <div className={s.stack}>
      <Password />
      <TwoStep status={mfa} refresh={() => void refreshMfa()} />
      <Devices />
    </div>
  );
}

// ---------------------------------------------------------------- password

function Password() {
  const { viewer } = usePrefs();
  const { data, mutate } = useApi<{ changedAt: number | null }>("/api/me/password");
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({ current: "", next: "", confirm: "", signOutOthers: true });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string; code?: string } | null>(null);
  const [blockedUntil, setBlockedUntil] = React.useState<number | null>(null);
  const wait = useCountdown(blockedUntil);

  function close() {
    setOpen(false);
    setError(null);
    setF({ current: "", next: "", confirm: "", signOutOthers: true });
  }

  async function save() {
    if (busy || wait > 0) return;
    if (!f.current) return setError({ message: "Enter your current password.", field: "current" });
    if (!f.next) return setError({ message: "Choose a new password.", field: "next" });
    if (f.next !== f.confirm) return setError({ message: "The new passwords don't match.", field: "confirm" });
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ signedOut: number }>("/api/me/password", { current: f.current, next: f.next, signOutOthers: f.signOutOthers });
      toast.success("Password changed", { description: r.signedOut ? `${r.signedOut} other ${r.signedOut === 1 ? "device was" : "devices were"} signed out.` : undefined });
      close();
      void mutate();
    } catch (e) {
      const after = retryAfterOf(e);
      if (after) setBlockedUntil(Date.now() + after * 1000);
      setError(e instanceof ApiError ? { message: e.message, field: e.field === "password" ? "next" : e.field, code: e.code } : { message: "Couldn't change it. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const err = (k: string) => (error?.field === k ? error.message : null);
  const general = error && !error.field ? (error.code === "rate_limited" && wait > 0 ? `Too many tries. You can try again in ${clock(wait)}.` : error.message) : null;

  return (
    <Panel title="Password">
      <SettingRow
        label="Your password"
        description={
          data?.changedAt ? (
            <>
              Last changed <Time ts={data.changedAt} />.
            </>
          ) : (
            "Used every time you sign in."
          )
        }
      >
        <Button onClick={() => setOpen(true)}>Change password</Button>
      </SettingRow>
      <Dialog
        open={open}
        onOpenChange={(o) => (o ? setOpen(true) : close())}
        title="Change your password"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={wait > 0} onClick={() => void save()}>
              Change password
            </Button>
          </>
        }
      >
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          noValidate
        >
          <input type="text" name="username" autoComplete="username" value={viewer.username} readOnly hidden />
          <Field label="Current password" error={err("current")}>
            <Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoFocus maxLength={256} />
          </Field>
          <div className={s.pair}>
            <Field label="New password" error={err("next")}>
              <Input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} maxLength={256} />
            </Field>
            <PasswordStrength value={f.next} context={[viewer.username, viewer.displayName]} />
          </div>
          <Field label="New password again" error={err("confirm")}>
            <Input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} maxLength={256} />
          </Field>
          <Checkbox checked={f.signOutOthers} onChange={(v) => setF({ ...f, signOutOthers: v })}>
            Sign out my other devices
          </Checkbox>
          {general && (
            <p className={s.error} role="alert">
              {general}
            </p>
          )}
          <button type="submit" hidden />
        </form>
      </Dialog>
    </Panel>
  );
}

// ---------------------------------------------------------------- two-step

function TwoStep({ status, refresh }: { status: MfaStatus | undefined; refresh: () => void }) {
  const router = useRouter();
  const { viewer, serverName } = usePrefs();
  const [mode, setMode] = React.useState<"idle" | "setup" | "move">("idle");
  /** Codes from finishing setup, shown inline as the flow's last step (regenerated ones use the dialog). */
  const [setupCodes, setSetupCodes] = React.useState<string[] | null>(null);
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  const begin = React.useCallback(() => api.post<Enrolment>("/api/me/mfa", { action: "begin" }), []);
  const confirmCode = React.useCallback(
    (e: Enrolment, code: string) => api.post<{ recoveryCodes: string[] }>("/api/me/mfa", { action: "confirm", secret: e.secret, ticket: e.ticket, code }).then((r) => r.recoveryCodes),
    [],
  );
  const cancel = React.useCallback(() => setMode("idle"), []);
  const done = React.useCallback(
    (c: string[]) => {
      setSetupCodes(c);
      refresh();
    },
    [refresh],
  );
  const finishSetup = React.useCallback(() => {
    toast.success(mode === "move" ? "Two-step sign-in moved to your new phone" : "Two-step sign-in is on");
    setSetupCodes(null);
    setMode("idle");
    router.refresh();
  }, [mode, router]);

  async function regenerate() {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/api/me/mfa", { action: "regenerate" });
      setCodes(r.recoveryCodes);
      refresh();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(e instanceof Error ? e.message : "Couldn't make new codes.");
    } finally {
      setBusy(false);
    }
  }

  const on = status?.enabled ?? viewer.mfa;
  const left = status?.recoveryLeft ?? 0;
  const lockedAway = viewer.role === "admin" && !!status?.requiredAway && status.zone === "away";

  let body: React.ReactNode;
  if (!status) {
    body = <Skeleton height={44} />;
  } else if (mode !== "idle") {
    body = (
      <div className={s.setupWrap}>
        <FlowSteps
          className={s.flow}
          label={mode === "move" ? "Move two-step sign-in to a new phone" : "Set up two-step sign-in"}
          steps={[
            { key: "link", label: mode === "move" ? "Link the new phone" : "Link your authenticator app" },
            { key: "codes", label: "Save recovery codes" },
          ]}
          current={setupCodes ? "codes" : "link"}
        />
        <div className={s.phase}>
          {setupCodes ? (
            <div className="appear" key="codes">
              <RecoveryCodes codes={setupCodes} username={viewer.username} serverName={serverName} />
              <div className={s.phaseFoot}>
                <Button variant="primary" onClick={finishSetup}>
                  I've saved them
                </Button>
              </div>
            </div>
          ) : (
            <div key="link">
              {mode === "move" && <p className={s.lead}>Scan this with the authenticator app on your new phone. Your old phone's codes stop working once you finish.</p>}
              <TwoStepSetup begin={begin} confirm={confirmCode} onDone={done} onCancel={cancel} confirmLabel={mode === "move" ? "Move to this phone" : "Turn on"} />
            </div>
          )}
        </div>
      </div>
    );
  } else if (on) {
    body = (
      <>
        <div className={s.statusRow}>
          <StateLine state="running" />
          <div className={s.statusText}>
            <span className={s.statusTitle}>On</span>
            <span className={s.statusSub}>Signing in asks for a code from your authenticator app.</span>
          </div>
        </div>
        <SettingRow
          label="Recovery codes"
          description={
            left === 0 ? (
              <span className={s.attnText}>None left. Make new ones so a lost phone can't lock you out.</span>
            ) : left <= 2 ? (
              <span className={s.attnText}>
                Only <b className={s.fig}>{left}</b> left. Make new ones soon.
              </span>
            ) : (
              <>
                <b className={s.fig}>{left}</b> of 10 left. Each one works once if you lose your phone.
              </>
            )
          }
        >
          <Button onClick={() => void regenerate()} loading={busy}>
            Make new codes
          </Button>
        </SettingRow>
        <SettingRow label="New phone?" description="Link a different authenticator app. The old one stops working.">
          <Button onClick={() => setMode("move")}>Move to a new phone</Button>
        </SettingRow>
        <SettingRow
          label="Turn off"
          description={lockedAway ? "Admins can only turn this off from the home network." : viewer.role === "admin" && status.requiredAway ? "You'd only be able to sign in from home again." : "Signing in would need only your password."}
        >
          <Button
            variant="danger"
            disabled={lockedAway}
            onClick={() =>
              confirm({
                title: "Turn off two-step sign-in?",
                consequences: [
                  "Anyone who learns your password could sign in as you.",
                  "Your recovery codes stop working.",
                  ...(viewer.role === "admin" && status.requiredAway ? ["As an admin, you won't be able to sign in from outside home until you turn it on again."] : []),
                ],
                confirmLabel: "Turn off",
                variant: "danger",
                onConfirm: async () => {
                  await api.post("/api/me/mfa", { action: "disable" });
                  toast.success("Two-step sign-in is off");
                  refresh();
                  router.refresh();
                },
              })
            }
          >
            Turn off
          </Button>
        </SettingRow>
      </>
    );
  } else {
    body = (
      <>
        {viewer.role === "admin" && status.requiredAway && (
          <div className={s.notice}>
            <Notice tone="attention" title="You can only sign in at home">
              Admins need two-step sign-in to connect from outside the home network. It takes a minute and an app on your phone.
            </Notice>
          </div>
        )}
        <div className={s.statusRow}>
          <StateLine state="stopped" />
          <div className={s.statusText}>
            <span className={s.statusTitle}>Off</span>
            <span className={s.statusSub}>Add a code from your phone when you sign in, so a leaked password isn't enough.</span>
          </div>
          <Button variant="primary" onClick={() => setMode("setup")}>
            Set up
          </Button>
        </div>
      </>
    );
  }

  return (
    <Panel title="Two-step sign-in">
      {body}
      <Dialog
        open={!!codes}
        onOpenChange={() => undefined}
        title="Save your recovery codes"
        description="Your old codes stopped working. Keep these somewhere safe."
        footer={
          <Button variant="primary" onClick={() => setCodes(null)}>
            I've saved them
          </Button>
        }
      >
        {codes && <RecoveryCodes codes={codes} username={viewer.username} serverName={serverName} />}
      </Dialog>
      {confirmNode}
    </Panel>
  );
}

// ---------------------------------------------------------------- devices

/**
 * Every signed-in browser as a lane on a shared 60-day scale (30 days back, 30 ahead): a solid line
 * while it was signed in from home (dashed from away), a faint line while it sits idle, and a dotted
 * tail until it signs itself out. Stale sessions read at a glance as long faint lines.
 */
function Devices() {
  const { data, mutate, isLoading, error } = useApi<SessionRow[]>("/api/me/sessions", { refresh: 60_000 });
  const [confirm, confirmNode] = useConfirm();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const list = data ?? [];
  const others = list.filter((x) => !x.current);
  const flagged = list.filter((x) => x.newDevice);

  async function signOut(x: SessionRow) {
    try {
      await api.del("/api/me/sessions", { id: x.id });
      toast.success(`Signed out ${device(x.userAgent)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't sign it out.");
    }
    void mutate();
  }
  async function itWasMe(x: SessionRow) {
    try {
      await api.patch("/api/me/sessions", { id: x.id });
      void mutate();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(e instanceof Error ? e.message : "Couldn't do that.");
    }
  }

  const summary = !data
    ? null
    : `${list.length} signed-in ${list.length === 1 ? "device" : "devices"}${list.some((x) => x.zone === "away") ? `, ${list.filter((x) => x.zone === "away").length} away from home` : ""}.`;

  return (
    <Panel
      title="Where you're signed in"
      flush
      meta={
        others.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              confirm({
                title: "Sign out everywhere else?",
                consequences: [`${others.length} other ${others.length === 1 ? "device" : "devices"} will need to sign in again.`, "This device stays signed in."],
                confirmLabel: "Sign them out",
                variant: "primary",
                onConfirm: async () => {
                  const r = await api.del<{ revoked: number }>("/api/me/sessions", { others: true });
                  toast.success(`Signed out ${r.revoked} ${r.revoked === 1 ? "device" : "devices"}`);
                  void mutate();
                },
              })
            }
          >
            Sign out all others
          </Button>
        ) : undefined
      }
    >
      {flagged.length > 0 && (
        <div className={s.flagNotice}>
          <Notice tone="attention" title={flagged.length === 1 ? "A new device signed in from outside home" : `${flagged.length} new devices signed in from outside home`}>
            If you don't recognise it, sign it out and change your password.
          </Notice>
        </div>
      )}
      {error ? (
        <div className={s.pad}>
          <Notice tone="fault" title="Couldn't load your devices" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
            {error.message}
          </Notice>
        </div>
      ) : isLoading && !data ? (
        <div className={s.pad}>
          <Skeleton height={56} />
        </div>
      ) : (
        <>
          <div className={s.axis} aria-hidden>
            <span />
            <div className={s.axisScale}>
              <span style={{ left: "0%" }}>30 days ago</span>
              <span style={{ left: "50%" }} data-now="">
                Now
              </span>
              <span style={{ left: "100%" }}>In 30 days</span>
            </div>
            <span />
          </div>
          <ul className={s.devices} role="list" aria-label={summary ?? "Signed-in devices"}>
            {list.map((x) => (
              <DeviceRow key={x.id} x={x} now={now} onSignOut={() => void signOut(x)} onConfirm={() => void itWasMe(x)} />
            ))}
          </ul>
          <p className={s.legend}>
            <span className={s.legendItem}>
              <i data-k="home" /> Used at home
            </span>
            <span className={s.legendItem}>
              <i data-k="away" /> Used away
            </span>
            <span className={s.legendItem}>
              <i data-k="idle" /> Idle
            </span>
            <span className={s.legendItem}>
              <i data-k="left" /> Stays signed in until
            </span>
            <span className={s.legendScale}>Each line spans 30 days back to 30 days ahead.</span>
          </p>
        </>
      )}
      {confirmNode}
    </Panel>
  );
}

const pos = (t: number, now: number) => Math.max(0, Math.min(100, ((t - (now - 30 * DAY)) / (60 * DAY)) * 100));

function DeviceRow({ x, now, onSignOut, onConfirm }: { x: SessionRow; now: number; onSignOut: () => void; onConfirm: () => void }) {
  const fmt = useFormat();
  const name = device(x.userAgent);
  const start = pos(x.createdAt, now);
  const seen = pos(Math.min(x.lastSeenAt, now), now);
  const mid = pos(now, now);
  const end = pos(x.expiresAt, now);
  const clipped = x.createdAt < now - 30 * DAY;
  const lane = `Signed in ${fmt.date(x.createdAt)}, last active ${fmt.dateTime(x.lastSeenAt)}, signs itself out by ${fmt.date(x.expiresAt)} if not used.`;
  return (
    <li className={s.device} data-flag={x.newDevice ? "" : undefined}>
      <div className={s.deviceText}>
        <span className={s.deviceName}>
          {x.newDevice && <StateLine state="attention" size={12} label={false} />}
          <span className={s.truncate} title={x.userAgent ?? undefined}>
            {name}
          </span>
          {x.current ? <span className={s.tag}>This device</span> : x.sameDevice ? <span className={s.tag}>Same browser, older sign-in</span> : x.newDevice ? <span className={s.tagAttn}>New, away from home</span> : null}
        </span>
        <span className={s.deviceSub}>
          {x.zone === "home" ? "At home" : "Away"}
          {x.ip && x.ip !== "unknown" && (
            <>
              {" · "}
              <span className="mono">{x.ip}</span>
            </>
          )}
          {" · "}
          {x.current ? "active now" : <>active <Time ts={x.lastSeenAt} /></>}
        </span>
      </div>
      <div className={s.lane} role="img" aria-label={lane}>
        <span className={s.nowLine} style={{ left: `${mid}%` }} />
        {clipped && <span className={s.clip} />}
        <span className={s.seg} data-k={x.zone} style={{ left: `${start}%`, width: `${Math.max(0.8, seen - start)}%` }} />
        {seen < mid && <span className={s.seg} data-k="idle" style={{ left: `${seen}%`, width: `${mid - seen}%` }} />}
        <span className={s.seg} data-k="left" style={{ left: `${mid}%`, width: `${Math.max(0, end - mid)}%` }} />
        <span className={s.startTick} style={{ left: `${start}%` }} />
      </div>
      <div className={s.deviceActions}>
        {x.newDevice && (
          <Button size="sm" onClick={onConfirm}>
            That was me
          </Button>
        )}
        {!x.current && (
          <Button size="sm" variant={x.newDevice ? "danger" : "ghost"} onClick={onSignOut}>
            Sign out
          </Button>
        )}
      </div>
    </li>
  );
}
