"use client";
import * as React from "react";
import { mutate as mutateGlobal } from "swr";
import type { PlatformInfo, PlatformSetting } from "@/server/platform";
import { api, useApi } from "@/lib/client/api";
import { Panel, Skeleton, Notice } from "@/components/ui/Surface";
import { StateLine, type LineState } from "@/components/ui/StateLine";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import s from "./settings.module.css";

const OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "umbrel", label: "Umbrel" },
  { value: "casaos", label: "CasaOS" },
  { value: "none", label: "Docker only" },
] as const satisfies readonly { value: PlatformSetting; label: string }[];

/** What Gluon found for each choice, drawn as a state line. */
function detected(p: PlatformInfo, v: PlatformSetting): { line: LineState; text: string } {
  if (v === "auto") {
    const pick = p.umbrel.found ? "Umbrel" : p.casaos.found ? "CasaOS" : "Docker only";
    return { line: "running", text: p.setting === "auto" ? `Using ${pick}` : `Would use ${pick}` };
  }
  if (v === "umbrel") return p.umbrel.found ? { line: "running", text: p.umbrel.version ? `Running ${p.umbrel.version}` : "Running" } : { line: "stopped", text: "Not found" };
  if (v === "casaos") return p.casaos.found ? { line: "running", text: p.casaos.version ? `Installed, ${p.casaos.version}` : "Installed" } : { line: "stopped", text: "Not installed" };
  return { line: "running", text: "Always available" };
}

const umbrelName = (p: PlatformInfo) => (p.umbrel.version ? `Umbrel (${p.umbrel.version})` : "Umbrel");
const casaName = (p: PlatformInfo) => (p.casaos.version ? `CasaOS ${p.casaos.version}` : "CasaOS");

/** One plain sentence: what Gluon works with right now, and what else is on the server. */
function statusSentence(p: PlatformInfo): string {
  const auto = p.setting === "auto";
  if (p.active === "umbrel") {
    const lead = p.umbrel.found ? `Working with ${umbrelName(p)}` : "Set to work with Umbrel";
    const how = auto ? ", picked automatically because it's running" : "";
    const also = p.casaos.found ? ` ${casaName(p)} is also installed.` : "";
    return `${lead}${how}.${also}`;
  }
  if (p.active === "casaos") {
    const lead = p.casaos.found ? `Working with ${casaName(p)}` : "Set to work with CasaOS";
    const how = auto ? ", picked automatically because Umbrel isn't running" : "";
    const also = p.umbrel.found ? ` ${umbrelName(p)} is also running.` : "";
    return `${lead}${how}.${also}`;
  }
  // Plain Docker.
  if (auto) return "Neither Umbrel nor CasaOS was found, so Gluon manages apps with Docker on its own.";
  const found = [p.umbrel.found && umbrelName(p), p.casaos.found && casaName(p)].filter(Boolean) as string[];
  if (found.length === 0) return "Gluon manages apps with Docker on its own. Neither Umbrel nor CasaOS is installed.";
  return `Gluon manages apps with Docker on its own. ${found.join(" and ")} ${found.length > 1 ? "are" : "is"} installed, but Gluon leaves ${found.length > 1 ? "them" : "it"} alone.`;
}

/** Which home server OS Gluon works alongside. Saved the moment it changes. */
export function WorksWith() {
  const { data, error, mutate, isLoading } = useApi<PlatformInfo>("/api/platform", { revalidateOnFocus: false });
  const [pending, setPending] = React.useState<PlatformSetting | null>(null);

  async function choose(next: PlatformSetting) {
    if (!data || next === data.setting) return;
    setPending(next);
    try {
      const info = await api.patch<PlatformInfo>("/api/platform", { platform: next });
      void mutate(info, { revalidate: false });
      // What the app list and store show depends on this.
      void mutateGlobal("/api/apps");
      void mutateGlobal("/api/store");
      const name = { umbrel: "Umbrel", casaos: "CasaOS", none: null }[info.active];
      if (next === "auto") toast.success("Gluon picks automatically now", { description: name ? `It's working with ${name}.` : "It found neither Umbrel nor CasaOS." });
      else toast.success(name ? `Gluon now works with ${name}` : "Gluon now manages apps with Docker on its own");
    } catch (e) {
      toast.error("Couldn't change what Gluon works with", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setPending(null);
    }
  }

  return (
    <Panel title="Works with">
      {isLoading && !data ? (
        <div className={s.worksWith} aria-busy>
          <Skeleton width="100%" height={64} radius={10} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="60%" height={13} />
        </div>
      ) : error && !data ? (
        <Notice tone="fault" title="Couldn't check for Umbrel and CasaOS" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      ) : data ? (
        <div className={s.worksWith}>
          <div
            className={s.platforms}
            role="radiogroup"
            aria-label="Works with"
            onKeyDown={(e) => {
              const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
              if (!keys.includes(e.key)) return;
              e.preventDefault();
              const i = OPTIONS.findIndex((o) => o.value === (pending ?? data.setting));
              const next = OPTIONS[(i + (keys.indexOf(e.key) < 2 ? 1 : OPTIONS.length - 1)) % OPTIONS.length]!.value;
              void choose(next);
              (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
            }}
          >
            {OPTIONS.map((o) => {
              const picked = (pending ?? data.setting) === o.value;
              const d = detected(data, o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={picked}
                  tabIndex={picked ? 0 : -1}
                  data-value={o.value}
                  className={s.platform}
                  disabled={!!pending && !picked}
                  onClick={() => void choose(o.value)}
                >
                  <span className={s.platformName}>{o.label}</span>
                  <span className={s.platformState}>
                    <StateLine state={d.line} label={d.text} size={11} />
                  </span>
                </button>
              );
            })}
          </div>
          <p className={s.worksWithStatus} role="status" aria-live="polite">
            {statusSentence(data)}
          </p>
          <p className={s.hint}>This decides where apps are installed, updated and removed, and which app store Gluon shows.</p>
          <Missing info={data} />
        </div>
      ) : null}
    </Panel>
  );
}

/** A platform chosen by hand that isn't on the server: say what that breaks. */
function Missing({ info }: { info: PlatformInfo }) {
  if (info.setting === "umbrel" && !info.umbrel.found) {
    return (
      <Notice tone="attention" title="Gluon can't reach Umbrel">
        Until it can, the app store is empty and installing, updating or uninstalling apps won't work. Check that Umbrel is running, or choose Automatic so Gluon falls back to what it finds.
      </Notice>
    );
  }
  if (info.setting === "casaos" && !info.casaos.found) {
    return (
      <Notice tone="attention" title="CasaOS isn't installed on this server">
        Until it is, there's no app store and Gluon manages apps with Docker on its own. Choose Automatic so Gluon works with what it finds.
      </Notice>
    );
  }
  return null;
}
