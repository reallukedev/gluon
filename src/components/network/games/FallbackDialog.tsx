"use client";
import * as React from "react";
import type { GamesStatus, McChangeResult } from "@/lib/games-types";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { craftyHostOf, craftyValue, GAMES_URL, javaServers, OTHER } from "./model";
import s from "../games.module.css";

const NONE = "__none";

/** Where players go when they connect by IP or by a name mc-router doesn't know. */
export function FallbackDialog({ open, onOpenChange, st, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; st: GamesStatus; onDone: (r: McChangeResult) => void }) {
  const servers = javaServers(st);
  const host = craftyHostOf(st, st.fallback?.target.kind === "crafty" ? st.fallback.backend : null);
  const [choice, setChoice] = React.useState(NONE);
  const [backend, setBackend] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setChoice(st.fallback ? craftyValue(st, st.fallback.target) : NONE);
    setBackend(st.fallback?.backend ?? "");
    setErr(null);
    // Only when it opens, so a refresh underneath doesn't undo the choice.
  }, [open]);

  const picked = servers.find((x) => x.id === choice);
  const value = choice === NONE ? null : picked ? `${host}:${picked.port}` : backend.trim();
  const unchanged = value === (st.fallback?.backend ?? null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      onDone(await api.put<McChangeResult>(`${GAMES_URL}/minecraft`, { fallback: value, rev: st.mcRouter.rev }));
      onOpenChange(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setErr(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Players on any other address"
      description="Someone who types your IP address, or a name that isn't in the list, reaches this server."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={unchanged || value === ""} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (!unchanged && value !== "") void save();
        }}
      >
        <Field label="They reach" error={choice !== OTHER ? err : null}>
          <Select
            value={choice}
            onChange={setChoice}
            aria-label="They reach"
            options={[
              ...servers.map((x) => ({ value: x.id, label: x.name, description: `Port ${x.port}` })),
              { value: OTHER, label: "Another server", description: "Any host:port mc-router can reach" },
              { value: NONE, label: "Nobody", description: "mc-router turns them away" },
            ]}
          />
        </Field>
        {choice === OTHER && (
          <Field label="Host and port" error={err}>
            <Input value={backend} onChange={(e) => setBackend(e.target.value)} placeholder={`${host}:25565`} name="backend" mono spellCheck={false} autoCapitalize="off" autoComplete="off" />
          </Field>
        )}
      </form>
    </Dialog>
  );
}
