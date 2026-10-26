"use client";
import * as React from "react";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { Page as PageIcon, Folder, Archive } from "iconoir-react";
import { api } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { formatBytes, plural } from "@/lib/format";
import { SITE_LIMITS, type SiteDetail } from "@/lib/sites-types";
import { fromInput, importZip, sortPicked, uploadAll, type Picked } from "./client";
import s from "./sites.module.css";

export type StartWith = "starter" | "files" | "zip";

const OPTIONS: { value: StartWith; title: string; icon: React.ReactNode }[] = [
  { value: "starter", title: "A simple page", icon: <PageIcon /> },
  { value: "files", title: "Files or a folder", icon: <Folder /> },
  { value: "zip", title: "A .zip", icon: <Archive /> },
];

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  start: StartWith;
  baseDomain: string;
  onCreated: (id: string) => void;
}

/** Name it, pick how it starts, and land in the editor with something to look at. */
export function NewSiteDialog({ open, onOpenChange, start: initialStart, baseDomain, onCreated }: Props) {
  const [name, setName] = React.useState("");
  const [start, setStart] = React.useState<StartWith>(initialStart);
  const [picked, setPicked] = React.useState<{ ok: Picked[]; skipped: { rel: string; reason: string }[]; junk: number; from: string } | null>(null);
  const [zip, setZip] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const filesRef = React.useRef<HTMLInputElement>(null);
  const folderRef = React.useRef<HTMLInputElement>(null);
  const zipRef = React.useRef<HTMLInputElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);

  const suggest = (n: string) => setName((cur) => cur || n.replace(/\.zip$/i, "").replace(/[-_]+/g, " ").trim().slice(0, 60));

  function onFiles(list: FileList | null, folder: boolean) {
    const all = fromInput(list, "");
    if (!all.length) return;
    const top = folder ? ((all[0]!.file as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] ?? "") : "";
    if (top) suggest(top);
    setPicked({ ...sortPicked(all), from: top });
    setError(null);
  }

  const size = picked?.ok.reduce((n, p) => n + p.file.size, 0) ?? 0;
  const tooMany = !!picked && picked.ok.length > SITE_LIMITS.files;
  const tooBig = size > SITE_LIMITS.siteBytes;
  const zipTooBig = !!zip && zip.size > SITE_LIMITS.zipBytes;
  const ready = start === "starter" || (start === "files" ? !!picked?.ok.length && !tooMany && !tooBig : !!zip && !zipTooBig);

  async function create() {
    const n = name.trim();
    if (!n) {
      setNameError("Give the site a name.");
      nameRef.current?.focus();
      return;
    }
    setBusy("Making the site…");
    setError(null);
    let site: SiteDetail;
    try {
      site = await api.post<SiteDetail>("/api/sites", { name: n, start: start === "starter" ? "starter" : "empty" });
    } catch (e) {
      setBusy(null);
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      if (/name/i.test(msg)) setNameError(msg);
      else setError(msg);
      return;
    }
    try {
      if (start === "files" && picked) {
        const r = await uploadAll(site.id, picked.ok, true, (p) => setBusy(`Uploading ${Math.min(p.done + 1, p.total)} of ${p.total}…`));
        if (r.failed.length) toast.error(`${plural(r.failed.length, "file")} didn't upload`, { description: `${r.failed[0]!.rel}: ${r.failed[0]!.message}` });
      } else if (start === "zip" && zip) {
        setBusy("Unpacking the zip…");
        const r = await importZip(site.id, zip, "");
        if (r.skipped.length) toast.attention(`Skipped ${plural(r.skipped.length, "file")} from the zip`, { description: `${r.skipped[0]!.path}: ${r.skipped[0]!.reason}` });
      }
    } catch (e) {
      // The site exists; say what didn't arrive and open it anyway so it can be fixed there.
      toast.error("The site was made, but its files didn't all arrive", { description: e instanceof Error ? e.message : undefined });
    }
    setBusy(null);
    onOpenChange(false);
    onCreated(site.id);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="New site"
      description={`You can edit it here and see it before anyone else does. Publishing gives it an address like ${name.trim() ? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "name" : "name"}.${baseDomain}.`}
      initialFocus={nameRef}
      footerStart={busy ? <span className={s.busyText} aria-live="polite">{busy}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} loading={!!busy} disabled={!ready}>
            Make the site
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void create();
        }}
      >
        <Field label="Name" error={nameError} description="For you; visitors see the page's own title.">
          <Input ref={nameRef} value={name} onChange={(e) => (setName(e.target.value), setNameError(null))} maxLength={60} placeholder="Family recipes" autoComplete="off" />
        </Field>
        <div className={s.startBlock}>
          <span className={s.fieldLabel} id="site-start-label">
            Start with
          </span>
          <RadioGroup value={start} onValueChange={(v) => (setStart(v as StartWith), setError(null))} aria-labelledby="site-start-label" className={s.picker}>
            {OPTIONS.map((o) => (
              <Radio.Root key={o.value} value={o.value} className={s.pick} nativeButton render={<button type="button" />}>
                {o.icon}
                <span>{o.title}</span>
              </Radio.Root>
            ))}
          </RadioGroup>
          {start === "starter" && <p className={s.startDesc}>A front page, a stylesheet and a “page not found” page, ready to change. They work on phones and in dark mode.</p>}
          {start === "files" && (
            <div className={s.startBody}>
              <p className={s.startDesc}>Pick the files of your site, or the folder they&rsquo;re in. Its index.html becomes the front page.</p>
              <div className={s.pickRow}>
                <Button size="sm" onClick={() => filesRef.current?.click()}>
                  Choose files
                </Button>
                <Button size="sm" onClick={() => folderRef.current?.click()}>
                  Choose a folder
                </Button>
                {picked && (
                  <span className={s.pickedText}>
                    {plural(picked.ok.length, "file")}, {formatBytes(size)}
                    {picked.from ? ` from ${picked.from}` : ""}
                  </span>
                )}
              </div>
              {picked && !picked.ok.some((p) => p.rel === "index.html") && picked.ok.length > 0 && <p className={s.startDesc}>There&rsquo;s no index.html at the top. You can add one in the editor before you publish.</p>}
              {(tooMany || tooBig) && (
                <Notice tone="fault">
                  {tooMany ? `That's ${picked!.ok.length} files; a site can have up to ${SITE_LIMITS.files}.` : `That's ${formatBytes(size)}; a site can hold up to ${formatBytes(SITE_LIMITS.siteBytes)}.`}
                </Notice>
              )}
              {picked && picked.skipped.length > 0 && (
                <Notice tone="attention" title={`${plural(picked.skipped.length, "file")} can't go on a site and will be left out`}>
                  {picked.skipped[0]!.rel}: {picked.skipped[0]!.reason}
                </Notice>
              )}
              <input ref={filesRef} type="file" multiple hidden onChange={(e) => (onFiles(e.target.files, false), (e.target.value = ""))} />
              <input ref={folderRef} type="file" hidden {...({ webkitdirectory: "" } as object)} onChange={(e) => (onFiles(e.target.files, true), (e.target.value = ""))} />
            </div>
          )}
          {start === "zip" && (
            <div className={s.startBody}>
              <p className={s.startDesc}>Gluon unpacks it into the site. If everything in it sits in one folder, the site is what&rsquo;s inside that folder.</p>
              <div className={s.pickRow}>
                <Button size="sm" onClick={() => zipRef.current?.click()}>
                  Choose a .zip
                </Button>
                {zip && (
                  <span className={s.pickedText}>
                    {zip.name}, {formatBytes(zip.size)}
                  </span>
                )}
              </div>
              {zipTooBig && <Notice tone="fault">That zip is {formatBytes(zip!.size)}; Gluon takes up to {formatBytes(SITE_LIMITS.zipBytes)} at once.</Notice>}
              <input
                ref={zipRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setZip(f);
                  if (f) suggest(f.name);
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </div>
        {error && <Notice tone="fault">{error}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
