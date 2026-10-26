"use client";
import * as React from "react";
import type { GamesStatus, McChangeResult, McRoute } from "@/lib/games-types";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { craftyHostOf, craftyValue, GAMES_URL, javaServers, OTHER, portMates, slug } from "./model";
import s from "../games.module.css";

/**
 * Add an address, or change one: which server it reaches (a Crafty server, or any host:port) and
 * the name players type. New addresses default to the server's name under the domain the others use.
 */
export function AddressDialog({ open, onOpenChange, st, edit, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; st: GamesStatus; edit: McRoute | null; onDone: (r: McChangeResult, verb: "added" | "changed") => void }) {
  const servers = javaServers(st);
  const craftyHost = craftyHostOf(st, edit?.target.kind === "crafty" ? edit.backend : null);
  const [server, setServer] = React.useState(OTHER);
  const [backend, setBackend] = React.useState("");
  const [host, setHost] = React.useState("");
  const [hostTouched, setHostTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<{ field: string | null; message: string } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const first = servers.find((x) => !st.routes.some((r) => r.target.kind === "crafty" && r.target.port === x.port)) ?? servers[0];
    const v = edit ? craftyValue(st, edit.target) : (first?.id ?? OTHER);
    setServer(v);
    setBackend(edit?.backend ?? "");
    setHost(edit?.host ?? (first && st.domain ? `${slug(first.name)}.${st.domain}` : ""));
    setHostTouched(!!edit);
    setErr(null);
    // Only when it opens: the list refreshing underneath shouldn't reset what's typed.
  }, [open]);

  const picked = servers.find((x) => x.id === server) ?? null;
  const mates = picked ? portMates(st, picked) : [];
  const value = picked ? `${craftyHost}:${picked.port}` : backend.trim();

  function choose(v: string) {
    setServer(v);
    const p = servers.find((x) => x.id === v);
    if (p && !hostTouched && st.domain) setHost(`${slug(p.name)}.${st.domain}`);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = edit
        ? await api.patch<McChangeResult>(`${GAMES_URL}/minecraft`, { host: edit.host, rename: host.trim() !== edit.host ? host.trim() : null, backend: value !== edit.backend ? value : null, rev: st.mcRouter.rev })
        : await api.post<McChangeResult>(`${GAMES_URL}/minecraft`, { host: host.trim(), backend: value, rev: st.mcRouter.rev });
      onDone(r, edit ? "changed" : "added");
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setErr({ field: e instanceof ApiError ? (e.field ?? null) : null, message: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  }

  const options = [
    ...servers.map((x) => ({ value: x.id, label: x.name, description: `Port ${x.port}${x.running === true ? ", running" : x.running === false ? ", stopped" : ""}` })),
    { value: OTHER, label: servers.length ? "Another server" : "A server by host and port", description: "Any host:port mc-router can reach" },
  ];
  const unchanged = !!edit && host.trim().toLowerCase() === edit.host.toLowerCase() && value === edit.backend;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={edit ? `Change ${edit.host}` : "Add a Minecraft address"}
      description="Players type it in Multiplayer, with no port, and reach the server you pick."
      footerStart={err && !err.field ? <span className={s.formError}>{err.message}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!host.trim() || !value || unchanged} onClick={() => void save()}>
            {edit ? "Save" : "Add address"}
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (host.trim() && value && !unchanged) void save();
        }}
      >
        {servers.length > 0 && (
          <Field label="Server" description={mates.length ? `${mates.map((m) => m.name).join(", ")} ${mates.length === 1 ? "also uses" : "also use"} port ${picked!.port}, so this address reaches whichever one is running.` : picked ? `Crafty runs it on port ${picked.port}.` : undefined}>
            <Select value={server} onChange={choose} options={options} aria-label="Server" />
          </Field>
        )}
        {server === OTHER && (
          <Field label="Host and port" error={err?.field === "backend" ? err.message : null} description="A container name on mc-router's network, a host name or an IP address, then the port.">
            <Input value={backend} onChange={(e) => setBackend(e.target.value)} placeholder={`${craftyHost}:25566`} mono spellCheck={false} autoCapitalize="off" autoComplete="off" name="backend" />
          </Field>
        )}
        <Field label="Address players type" error={err?.field === "host" ? err.message : null} description={st.domain ? `Your other addresses are under ${st.domain}.` : "It needs a DNS record that points at your home."}>
          <Input
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setHostTouched(true);
            }}
            placeholder={st.domain ? `survival.${st.domain}` : "survival.mc.example.com"}
            mono
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            inputMode="url"
            name="host"
          />
        </Field>
      </form>
    </Dialog>
  );
}
