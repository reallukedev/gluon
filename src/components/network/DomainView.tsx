"use client";
import * as React from "react";
import { Plus, MoreHoriz, EditPencil, Trash, Lock, OpenNewWindow, Search } from "iconoir-react";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Page, PageHeader, Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { Button, IconButton, buttonClass } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { AffixInput, Field, Input, Switch } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { Tooltip } from "@/components/ui/Tooltip";
import { toast } from "@/components/ui/Toast";
import { EDITABLE_TYPES, type DnsRecordFull, type DnsRecordInput, type DnsZoneView, type EditableType } from "@/lib/cloudflare-types";
import d from "./domains.module.css";

/** Records Gluon keeps for public addresses are locked: Gluon would only write them back. */

const TTL_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "Auto" },
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "43200", label: "12 hours" },
  { value: "86400", label: "1 day" },
];
const ttlWords = (t: number) => TTL_OPTIONS.find((o) => Number(o.value) === t)?.label ?? (t >= 3600 ? `${Math.round(t / 3600)} h` : `${Math.round(t / 60)} min`);

const TYPE_HELP: Record<EditableType, { content: string; placeholder: string }> = {
  A: { content: "IPv4 address", placeholder: "203.0.113.7" },
  AAAA: { content: "IPv6 address", placeholder: "2001:db8::7" },
  CNAME: { content: "Points at", placeholder: "example.com" },
  TXT: { content: "Text", placeholder: "v=spf1 include:_spf.example.com ~all" },
  MX: { content: "Mail server", placeholder: "mx.example.com" },
  NS: { content: "Name server", placeholder: "ns1.example.com" },
};
const proxiable = (t: string) => t === "A" || t === "AAAA" || t === "CNAME";
const editable = (t: string): t is EditableType => (EDITABLE_TYPES as readonly string[]).includes(t);
const short = (name: string, zone: string) => (name === zone ? "@" : name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name);

const BACK = { href: "/network", label: "Network" };

/** The page goes out at once; its records follow when Cloudflare answers. */
export function DomainView({ zone, initial }: { zone: string; initial: Promise<DnsZoneView | null> }) {
  return (
    <Page>
      <React.Suspense fallback={<DomainSkeleton zone={zone} />}>
        <Domain zone={zone} initial={initial} />
      </React.Suspense>
    </Page>
  );
}

function DomainSkeleton({ zone }: { zone: string }) {
  return (
    <>
      <PageHeader
        back={BACK}
        title={zone}
        summary="Reading this domain's records…"
        actions={
          <Button variant="primary" icon={<Plus />} disabled>
            Add record
          </Button>
        }
      />
      <Panel flush>
        <div className={d.toolbar}>
          <div className={d.search}>
            <Skeleton height={34} radius={8} />
          </div>
        </div>
        <div className={d.pad} aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={36} radius={6} style={{ marginBottom: 8 }} />
          ))}
        </div>
      </Panel>
    </>
  );
}

function Domain({ zone, initial }: { zone: string; initial: Promise<DnsZoneView | null> }) {
  const { data, error, mutate, isLoading } = useApi<DnsZoneView>(`/api/cloudflare/zones/${encodeURIComponent(zone)}/records`, { fallbackData: React.use(initial) ?? undefined, revalidateOnFocus: true });
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<{ record: DnsRecordFull | null; n: number } | null>(null);
  const [open, setOpen] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  if (error && !data) {
    return (
      <>
        <PageHeader back={BACK} title={zone} summary="Couldn't read this domain's DNS records." />
        <Notice tone="fault" title="Couldn't load the records" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      </>
    );
  }

  const records = data?.records ?? [];
  const q = query.trim().toLowerCase();
  const shown = q ? records.filter((r) => `${r.type} ${r.name} ${r.content} ${r.comment ?? ""}`.toLowerCase().includes(q)) : records;
  const kept = records.filter((r) => r.managed).length;
  const add = () => {
    setEditing((e) => ({ record: null, n: (e?.n ?? 0) + 1 }));
    setOpen(true);
  };
  const edit = (r: DnsRecordFull) => {
    setEditing((e) => ({ record: r, n: (e?.n ?? 0) + 1 }));
    setOpen(true);
  };
  const remove = (r: DnsRecordFull) =>
    confirm({
      title: `Remove the ${r.type} record for ${r.name}?`,
      consequences: [`${r.name} stops answering with ${r.content.length > 60 ? `${r.content.slice(0, 60)}…` : r.content} as soon as resolvers notice, usually within minutes.`],
      confirmLabel: "Remove record",
      variant: "danger",
      onConfirm: async () => {
        const next = await api.del<DnsZoneView>(`/api/cloudflare/zones/${encodeURIComponent(zone)}/records/${encodeURIComponent(r.id)}`);
        void mutate(next, { revalidate: false });
        toast.success(`Removed the ${r.type} record for ${r.name}`);
      },
    });

  return (
    <>
      <PageHeader
        back={BACK}
        title={zone}
        summary={
          !data
            ? "Reading this domain's records…"
            : `${records.length === 1 ? "1 record" : `${records.length} records`}${kept ? `, ${kept} kept by Gluon for your public addresses` : ""}.`
        }
        actions={
          <>
            <Button variant="primary" icon={<Plus />} disabled={!data} onClick={add}>
              Add record
            </Button>
            {data && (
              <a className={buttonClass({})} href={data.dashboard} target="_blank" rel="noreferrer">
                <OpenNewWindow aria-hidden />
                <span>Open in Cloudflare</span>
              </a>
            )}
          </>
        }
      />

      <Panel flush>
        <div className={d.toolbar}>
          <div className={d.search}>
            <AffixInput before={<Search width={16} height={16} aria-hidden />} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a record" aria-label="Find a record" spellCheck={false} autoCapitalize="off" />
          </div>
        </div>
        {!data ? (
          <div className={d.pad} aria-busy={isLoading}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={36} radius={6} style={{ marginBottom: 8 }} />
            ))}
          </div>
        ) : records.length === 0 ? (
          <div className={d.pad}>
            <Empty title="No records yet" action={<Button icon={<Plus />} onClick={add}>Add record</Button>} />
          </div>
        ) : (
          <div role="table" aria-label={`DNS records for ${zone}`} className={d.table}>
            <div role="row" className={d.recHead}>
              <span role="columnheader">Type</span>
              <span role="columnheader">Name</span>
              <span role="columnheader">Content</span>
              <span role="columnheader">Proxy</span>
              <span role="columnheader">TTL</span>
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
            <div role="rowgroup">
              {shown.map((r) => (
                <div key={r.id} role="row" className={d.rec} data-managed={r.managed ? "" : undefined}>
                  <span role="cell" className={`${d.type} mono`}>
                    {r.type}
                  </span>
                  <span role="cell" className={`${d.recName} mono`} title={r.name}>
                    {short(r.name, zone)}
                  </span>
                  <span role="cell" className={d.content}>
                    <span className={`mono ${d.clamp}`} title={r.content.length > 80 ? r.content : undefined}>
                      {r.priority !== null && r.type === "MX" ? `${r.priority} ` : ""}
                      {r.content}
                    </span>
                    {r.managed ? <small>Kept by Gluon for a public address</small> : r.comment ? <small>{r.comment}</small> : null}
                  </span>
                  <span role="cell" className={d.proxy}>
                    {r.proxiable ? (r.proxied ? "Through Cloudflare" : "DNS only") : ""}
                  </span>
                  <span role="cell" className={d.ttl}>
                    {r.proxied ? "Auto" : ttlWords(r.ttl)}
                  </span>
                  <span role="cell">
                    {r.managed ? (
                      <Tooltip content="Change this on the Network page; Gluon keeps it in step with the address.">
                        <span className={d.kept} tabIndex={0} aria-label="Kept by Gluon">
                          <Lock />
                        </span>
                      </Tooltip>
                    ) : (
                      <Menu
                        trigger={
                          <IconButton label={`${r.type} ${r.name} options`} size="sm">
                            <MoreHoriz />
                          </IconButton>
                        }
                        items={
                          editable(r.type)
                            ? [
                                { label: "Edit", icon: <EditPencil />, onSelect: () => edit(r) },
                                "separator",
                                { label: "Remove", icon: <Trash />, danger: true, onSelect: () => remove(r) },
                              ]
                            : [
                                { label: "Edit in Cloudflare", icon: <OpenNewWindow />, href: data.dashboard },
                                "separator",
                                { label: "Remove", icon: <Trash />, danger: true, onSelect: () => remove(r) },
                              ]
                        }
                      />
                    )}
                  </span>
                </div>
              ))}
            </div>
            {q && shown.length === 0 && <p className={d.more}>No record matches “{query.trim()}”.</p>}
          </div>
        )}
      </Panel>

      {editing && data && (
        <RecordDialog
          key={editing.n}
          open={open}
          zone={zone}
          record={editing.record}
          onClose={() => setOpen(false)}
          onSaved={(next, msg) => {
            void mutate(next, { revalidate: false });
            setOpen(false);
            toast.success(msg);
          }}
        />
      )}
      {confirmNode}
    </>
  );
}

function RecordDialog({ open, zone, record, onClose, onSaved }: { open: boolean; zone: string; record: DnsRecordFull | null; onClose: () => void; onSaved: (v: DnsZoneView, msg: string) => void }) {
  const [form, setForm] = React.useState<DnsRecordInput>(() =>
    record && editable(record.type)
      ? { type: record.type, name: short(record.name, zone), content: record.content, proxied: record.proxied, ttl: record.ttl, priority: record.priority, comment: record.comment }
      : { type: "A", name: "", content: "", proxied: true, ttl: 1, priority: 10, comment: "" },
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const set = <K extends keyof DnsRecordInput>(k: K, v: DnsRecordInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  };
  const help = TYPE_HELP[form.type];
  const full = !form.name.trim() || form.name.trim() === "@" ? zone : form.name.trim().toLowerCase().endsWith(`.${zone}`) ? form.name.trim().toLowerCase() : `${form.name.trim().toLowerCase()}.${zone}`;
  const fieldError = (f: string) => (error?.field === f ? error.message : null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const url = `/api/cloudflare/zones/${encodeURIComponent(zone)}/records${record ? `/${encodeURIComponent(record.id)}` : ""}`;
      const body = { ...form, name: form.name.trim() || "@", priority: form.type === "MX" ? form.priority : null };
      const next = record ? await api.put<DnsZoneView>(url, body) : await api.post<DnsZoneView>(url, body);
      onSaved(next, `${record ? "Saved" : "Added"} the ${form.type} record for ${full}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setError(e instanceof ApiError ? { message: e.message, field: e.field } : { message: "Couldn't save the record." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={record ? `Edit ${record.type} record` : "Add a DNS record"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!form.content.trim()} onClick={() => void save()}>
            {record ? "Save record" : "Add record"}
          </Button>
        </>
      }
    >
      <form
        className={d.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={d.row2}>
          <Field label="Type" error={fieldError("type")}>
            <Select
              aria-label="Type"
              value={form.type}
              onChange={(t) => setForm((f) => ({ ...f, type: t, proxied: proxiable(t) ? f.proxied : false }))}
              options={EDITABLE_TYPES.map((t) => ({ value: t, label: t }))}
            />
          </Field>
          <Field label="Name" error={fieldError("name")} description="@ is the domain itself.">
            <AffixInput after={`.${zone}`} value={form.name} onChange={(e) => set("name", e.target.value.replace(/\s/g, ""))} placeholder="@" mono spellCheck={false} autoCapitalize="off" autoFocus={!record} />
          </Field>
        </div>
        <div className={form.type === "MX" ? d.row2 : undefined}>
          <Field label={help.content} error={fieldError("content")}>
            <Input value={form.content} onChange={(e) => set("content", e.target.value)} placeholder={help.placeholder} mono spellCheck={false} autoCapitalize="off" />
          </Field>
          {form.type === "MX" && (
            <Field label="Priority" error={fieldError("priority")} description="Lower is tried first.">
              <Input value={String(form.priority ?? "")} onChange={(e) => set("priority", e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "").slice(0, 5)))} inputMode="numeric" mono />
            </Field>
          )}
        </div>
        {proxiable(form.type) && (
          <label className={d.proxyRow}>
            <span>
              <b>Through Cloudflare</b>
              <small>Hides the address behind it. Web traffic only.</small>
            </span>
            <Switch checked={form.proxied} onChange={(v) => set("proxied", v)} aria-label="Through Cloudflare" />
          </label>
        )}
        <div className={d.row2}>
          <Field label="TTL" error={fieldError("ttl")} description={form.proxied ? "Automatic while it goes through Cloudflare." : undefined}>
            <Select aria-label="TTL" disabled={form.proxied} value={String(form.proxied ? 1 : form.ttl)} onChange={(v) => set("ttl", Number(v))} options={TTL_OPTIONS} />
          </Field>
          <Field label="Note" optional error={fieldError("comment")}>
            <Input value={form.comment ?? ""} onChange={(e) => set("comment", e.target.value)} maxLength={100} placeholder="What it's for" />
          </Field>
        </div>
        <p className={d.preview} aria-live="polite">
          <b className="mono">{full}</b> {form.type === "MX" ? "sends mail to" : form.type === "TXT" ? "says" : form.type === "NS" ? "is served by" : "points at"} <span className="mono">{form.content.trim() || "…"}</span>
          {proxiable(form.type) && form.proxied ? ", through Cloudflare" : ""}.
        </p>
        {error && !error.field && <Notice tone="fault">{error.message}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
