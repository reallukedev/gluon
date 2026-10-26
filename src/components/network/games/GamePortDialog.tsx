"use client";
import * as React from "react";
import { GAME_PRESETS, type GamePort, type GameProtocol, type GamesStatus } from "@/lib/games-types";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { GAMES_URL, protoText } from "./model";
import s from "../games.module.css";

const CUSTOM = "custom";

const PROTOCOLS: { value: GameProtocol; label: string }[] = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
  { value: "both", label: "Both" },
];

/**
 * A game that needs its own port. Presets fill in the usual ports; the public port defaults to
 * the same number, and the address to the domain the Minecraft addresses use.
 */
export function GamePortDialog({ open, onOpenChange, st, edit, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; st: GamesStatus; edit: GamePort | null; onDone: (st: GamesStatus, name: string) => void }) {
  const [game, setGame] = React.useState(CUSTOM);
  const [name, setName] = React.useState("");
  const [protocol, setProtocol] = React.useState<GameProtocol>("udp");
  const [ports, setPorts] = React.useState("");
  const [publicPort, setPublicPort] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<{ field: string | null; message: string } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setGame(edit?.game ?? GAME_PRESETS[0]!.id);
    if (edit) {
      setName(edit.name);
      setProtocol(edit.protocol);
      setPorts(edit.hostMin === edit.hostMax ? String(edit.hostMin) : `${edit.hostMin}-${edit.hostMax}`);
      setPublicPort(edit.publicMin === edit.hostMin ? "" : String(edit.publicMin));
      setAddress(edit.address ?? "");
    } else {
      fill(GAME_PRESETS[0]!.id);
      setPublicPort("");
      setAddress(st.domain ?? "");
    }
    setErr(null);
    // Only when it opens, so a refresh underneath doesn't reset the form.
  }, [open]);

  function fill(id: string) {
    setGame(id);
    const p = GAME_PRESETS.find((x) => x.id === id);
    if (!p) return;
    // A Bedrock server in Crafty is the likeliest one; use its name and port.
    const bedrock = id === "bedrock" ? st.crafty.servers.find((x) => x.type === "minecraft-bedrock" && x.port) : undefined;
    setName(bedrock ? bedrock.name : p.name);
    setProtocol(p.protocol);
    setPorts(bedrock ? String(bedrock.port) : p.ports);
  }

  const preset = GAME_PRESETS.find((x) => x.id === game);
  const first = Number(ports.trim().split(/\s*[-–]\s*/)[0]) || null;
  const shown = publicPort.trim() || (first ? String(first) : "");
  const preview = address.trim() && shown ? `${address.trim().replace(/:\d+$/, "")}:${shown}` : null;

  async function save() {
    setBusy(true);
    setErr(null);
    const body = { name: name.trim(), game: game === CUSTOM ? null : game, protocol, ports: ports.trim(), publicPort: publicPort.trim() ? Number(publicPort) : null, address: address.trim() || null };
    try {
      const next = edit ? await api.patch<GamesStatus>(`${GAMES_URL}/ports/${edit.id}`, body) : await api.post<GamesStatus>(`${GAMES_URL}/ports`, body);
      onDone(next, body.name);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setErr({ field: e instanceof ApiError ? (e.field ?? null) : null, message: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  }

  const fieldErr = (f: string) => (err?.field === f ? err.message : null);
  const ready = !!name.trim() && !!ports.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={edit ? `Change ${edit.name}` : "Add a game port"}
      description="For games that can't share an address the way Minecraft Java does. Gluon lists the port under Port forwarding, so your router can send players here."
      footerStart={err && !["name", "ports", "publicPort", "address"].includes(err.field ?? "") ? <span className={s.formError}>{err.message}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>
            {edit ? "Save" : "Add game port"}
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
      >
        <Field label="Game" description={preset?.note}>
          <Select value={game} onChange={fill} aria-label="Game" options={[...GAME_PRESETS.map((p) => ({ value: p.id, label: p.name, description: `${protoText(p.protocol)} ${p.ports}` })), { value: CUSTOM, label: "Something else" }]} />
        </Field>
        <Field label="Name" error={fieldErr("name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" name="name" />
        </Field>
        <Field label="Protocol">
          <Segmented value={protocol} onChange={setProtocol} options={PROTOCOLS} aria-label="Protocol" />
        </Field>
        <div className={s.formPair}>
          <Field label="Port on this server" error={fieldErr("ports")} description="One port, or a range like 2456-2457.">
            <Input value={ports} onChange={(e) => setPorts(e.target.value)} name="ports" mono inputMode="numeric" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Public port" optional error={fieldErr("publicPort")} description="What players type, if it's different.">
            <Input name="publicPort" value={publicPort} onChange={(e) => setPublicPort(e.target.value.replace(/\D/g, ""))} placeholder={first ? String(first) : ""} mono inputMode="numeric" maxLength={5} autoComplete="off" />
          </Field>
        </div>
        <Field label="Address players type" optional error={fieldErr("address")} description={preview ? `Players join ${preview}.` : "A name that points at your home, so Gluon can check it."}>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} name="address" placeholder={st.domain ?? "play.example.com"} mono spellCheck={false} autoCapitalize="off" autoComplete="off" inputMode="url" />
        </Field>
      </form>
    </Dialog>
  );
}
