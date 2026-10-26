"use client";
import * as React from "react";
import { Plus } from "iconoir-react";
import type { BuilderTarget, DockerNetworkInfo, Issue } from "@/lib/builder-types";
import { useApi } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Surface";
import { parseCompose, readNetworks, setServiceNetworks, type ServiceForm } from "@/lib/builder/compose";
import { networkNameError } from "@/lib/builder/names";
import { FieldNotes, issuesAt } from "../Issues";
import type { Draft } from "../state";
import s from "../builder.module.css";

/**
 * Which networks a service joins: the app's own (its services reach each other by name), Docker
 * networks already on this server (to reach a reverse proxy or a shared database), or a new one
 * made for this app.
 */
export function NetworksField({ draft, form: f, issues, target }: { draft: Draft; form: ServiceForm; issues: Issue[]; target: BuilderTarget }) {
  const { data, error, isLoading } = useApi<DockerNetworkInfo[]>(target === "compose" ? "/api/custom-apps/networks" : null, { revalidateOnFocus: false });
  const [adding, setAdding] = React.useState<string | null>(null);
  const base = `services.${f.name}.networks`;
  const slug = draft.spec.details.slug;
  const compose = draft.spec.compose;
  const declared = React.useMemo(() => {
    const p = parseCompose(compose);
    return p.ok ? readNetworks(p.doc) : [];
  }, [compose]);
  const joined = f.networks.length ? f.networks : ["default"];
  const onServer = (data ?? []).filter((n) => n.project !== slug && n.name !== `${slug}_default`);
  const own = declared.filter((d) => !d.external && !onServer.some((n) => n.name === d.name));
  const externalNames = [...onServer.map((n) => n.name), ...declared.filter((d) => d.external).map((d) => d.name)];
  const write = (next: string[]) => draft.editCompose((doc) => setServiceNetworks(doc, f.name, next, externalNames));
  const toggle = (name: string, on: boolean) => write(on ? [...joined, name] : joined.filter((n) => n !== name));
  const addErr = adding ? networkNameError(adding) ?? (joined.includes(adding) ? "It already joins that network." : null) : null;

  if (target === "umbrel") return <p className={s.hint}>Umbrel connects every app to its own network.</p>;
  if (f.hostNetwork) return <p className={s.hint}>It uses the server&apos;s network, so it doesn&apos;t join other networks.</p>;

  return (
    <div className={s.subGroup} data-field={base}>
      <h4 className={s.subTitle}>Networks</h4>
      <div className={s.netList}>
        <Checkbox checked={joined.includes("default")} disabled={joined.length === 1 && joined[0] === "default"} onChange={(on) => toggle("default", on)}>
          This app&apos;s own network <span className={s.muted}>(its services reach each other by name)</span>
        </Checkbox>
        {own.map((n) => (
          <Checkbox key={n.name} checked={joined.includes(n.name)} onChange={(on) => toggle(n.name, on)}>
            <span className="mono">{n.name}</span> <span className={s.muted}>(made for this app)</span>
          </Checkbox>
        ))}
        {isLoading && !data ? (
          <>
            <Skeleton width="60%" height={16} />
            <Skeleton width="45%" height={16} />
          </>
        ) : (
          onServer.map((n) => (
            <Checkbox key={n.name} checked={joined.includes(n.name)} onChange={(on) => toggle(n.name, on)}>
              <span className="mono">{n.name}</span> <span className={s.muted}>({n.project ? `from ${n.project}` : n.driver})</span>
            </Checkbox>
          ))
        )}
      </div>
      {error && <p className={s.hint}>Gluon couldn&apos;t list this server&apos;s networks: {error.message}</p>}
      {adding === null ? (
        <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setAdding("")}>
          Make a network for this app
        </Button>
      ) : (
        <form
          className={s.netAdd}
          onSubmit={(e) => {
            e.preventDefault();
            if (!adding || addErr) return;
            write([...joined, adding]);
            setAdding(null);
          }}
        >
          <Input value={adding} mono autoFocus aria-label="Network name" placeholder="backend" onChange={(e) => setAdding(e.target.value.trim())} aria-invalid={!!addErr || undefined} />
          <Button type="submit" disabled={!adding || !!addErr}>
            Add network
          </Button>
          <Button variant="ghost" onClick={() => setAdding(null)}>
            Cancel
          </Button>
          {addErr && (
            <p className={`${s.note} ${s.netAddNote}`} data-level="error">
              {addErr}
            </p>
          )}
        </form>
      )}
      <FieldNotes issues={issuesAt(issues, base)} errors />
    </div>
  );
}
