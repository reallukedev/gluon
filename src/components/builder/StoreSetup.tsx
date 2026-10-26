"use client";
import * as React from "react";
import { ApiError, api } from "@/lib/client/api";
import type { StoreStatus } from "@/lib/builder-types";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import s from "./builder.module.css";

type Phase = { kind: "checking" } | { kind: "ready"; address: string; reachable: boolean | null; storeId: string } | { kind: "unreachable"; address: string; detail: string | null } | { kind: "error"; message: string } | { kind: "adding" } | { kind: "done" };

/**
 * Adding Gluon's store to Umbrel, once. Opening the dialog writes the store and asks Umbrel's
 * container to fetch it (changes nothing in Umbrel); only "Add to Umbrel" registers it.
 */
export function StoreSetupDialog({ open, onOpenChange, onDone, repair }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (s: StoreStatus) => void; repair?: boolean }) {
  const [phase, setPhase] = React.useState<Phase>({ kind: "checking" });
  const run = React.useRef(0);

  const check = React.useCallback(async () => {
    const mine = ++run.current;
    setPhase({ kind: "checking" });
    try {
      const r = await api.post<{ address: string; reachable: boolean | null; detail: string | null; storeId: string }>("/api/custom-apps/store", { step: "check" });
      if (mine !== run.current) return;
      setPhase(r.reachable === false ? { kind: "unreachable", address: r.address, detail: r.detail } : { kind: "ready", address: r.address, reachable: r.reachable, storeId: r.storeId });
    } catch (e) {
      if (mine !== run.current) return;
      if (e instanceof ApiError && e.code === "reauth_cancelled") return onOpenChange(false);
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Gluon couldn't prepare its store." });
    }
  }, [onOpenChange]);

  React.useEffect(() => {
    if (open) void check();
    else run.current++;
  }, [open, check]);

  async function add() {
    setPhase({ kind: "adding" });
    try {
      const st = await api.post<StoreStatus>("/api/custom-apps/store", { step: "register" });
      setPhase({ kind: "done" });
      onDone(st);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return void check();
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Umbrel didn't add the store." });
    }
  }

  const host = (addr: string) => addr.split("/api/")[0]!.replace(/^https?:\/\//, "");
  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (phase.kind === "checking" || phase.kind === "adding") {
    body = (
      <div className={s.stack} aria-busy>
        <StateLine state="starting" size={12} label={phase.kind === "checking" ? "Checking that Umbrel can reach Gluon" : "Umbrel is reading the store"} />
        <Skeleton width="80%" height={13} />
        <Skeleton width="60%" height={13} />
      </div>
    );
    footer = <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={phase.kind === "adding"}>Cancel</Button>;
  } else if (phase.kind === "ready") {
    body = (
      <div className={s.stack}>
        <ul className={s.explain}>
          <li>
            Umbrel lists a community app store called <b>Made with Gluon</b>. Apps you publish from Gluon appear there and install, update and uninstall like any other app.
          </li>
          <li>
            Umbrel reads it from Gluon at <span className={s.mono}>{host(phase.address)}</span>, inside this server. The address has a secret part, and only Umbrel and this server can read it.
          </li>
          <li>Removing the store later is one click here, once no app from it is installed.</li>
        </ul>
        {phase.reachable === true && <StateLine state="running" size={12} label="Umbrel can reach Gluon" />}
        {phase.reachable === null && <p className={s.hint}>Gluon couldn't test the connection from Umbrel's side first; adding the store tests it.</p>}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void add()}>
          {repair ? "Add it again" : "Add to Umbrel"}
        </Button>
      </>
    );
  } else if (phase.kind === "unreachable") {
    body = (
      <Notice tone="fault" title="Umbrel can't reach Gluon">
        Umbrel tried <span className={s.mono}>{host(phase.address)}</span> and got no answer. Gluon listens on the host network; check that a firewall doesn&apos;t block Docker&apos;s networks from this port.
        {phase.detail && <pre className={`${s.log} ${s.logAfter}`}>{phase.detail}</pre>}
      </Notice>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button onClick={() => void check()}>Try again</Button>
      </>
    );
  } else if (phase.kind === "error") {
    body = <Notice tone="fault" title="That didn't work">{phase.message}</Notice>;
    footer = (
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button onClick={() => void check()}>Try again</Button>
      </>
    );
  } else {
    body = <StateLine state="running" size={12} label="Umbrel lists Gluon's store" />;
    footer = (
      <Button variant="primary" onClick={() => onOpenChange(false)}>
        Done
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => phase.kind !== "adding" && onOpenChange(o)} title={repair ? "Add Gluon's store to Umbrel again" : "Add Gluon's app store to Umbrel"} description={repair ? "Umbrel no longer lists it, so it can't install or update the apps you made." : "Gluon hosts a small app store for the apps you make. Umbrel needs to know about it once."} footer={footer}>
      {body}
    </Dialog>
  );
}
