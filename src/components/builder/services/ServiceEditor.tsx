"use client";
import * as React from "react";
import { MoreHoriz } from "iconoir-react";
import type { BuilderSource, BuilderTarget, Issue } from "@/lib/builder-types";
import type { Places } from "@/lib/files-types";
import { Panel } from "@/components/ui/Surface";
import { IconButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { useConfirm } from "@/components/ui/Dialog";
import { removeService, renameService, setBuild, setImage, setPendingFolders, setPorts, setVolumes, type ServiceForm } from "@/lib/builder/compose";
import { dataFolderFor, mediaKind } from "@/lib/builder/names";
import { pickWebPort } from "@/lib/builder/start";
import { ImageField, useImageLookup, type ImageLookupState } from "../ImageField";
import { FieldNotes, errorAt, issuesAt } from "../Issues";
import type { Draft } from "../state";
import { AdvancedGroup } from "./AdvancedGroup";
import { EnvGroup } from "./EnvGroup";
import { NameDialog } from "./NameDialog";
import { PortsGroup } from "./PortsGroup";
import { VolumesGroup } from "./VolumesGroup";
import s from "../builder.module.css";

interface ServiceProps {
  draft: Draft;
  form: ServiceForm;
  issues: Issue[];
  target: BuilderTarget;
  places: Places | undefined;
  usedPorts?: Map<number, string>;
  onFix: (id: string) => void;
}

/** One service in full, as the builder's Services tab shows it. */
export function ServiceEditor({ names, source, ...p }: ServiceProps & { names: string[]; source: BuilderSource }) {
  const { draft, form: f, issues, target } = p;
  const isWeb = draft.spec.web.service === f.name;
  const [renaming, setRenaming] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const lookup = useImageLookup(f.build ? "" : f.image);
  const secretKeys = draft.secrets[f.name] ?? [];

  const remove = () =>
    confirm({
      title: `Remove “${f.name}”?`,
      description: "It's removed from this app's compose file. Nothing changes where the app runs until you publish.",
      consequences: [
        ...(isWeb ? ["The app won't have a web page until you choose another service."] : []),
        ...(secretKeys.length ? [`Its ${secretKeys.length === 1 ? "secret" : `${secretKeys.length} secrets`} (${secretKeys.join(", ")}) ${secretKeys.length === 1 ? "is" : "are"} deleted.`] : []),
        "Its data folders stay in the app's data folder.",
      ],
      confirmLabel: "Remove service",
      variant: "danger",
      onConfirm: () => {
        draft.editCompose((doc) => removeService(doc, f.name));
        for (const k of secretKeys) draft.removeSecret(f.name, k);
        if (isWeb) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: null, containerPort: null } }));
      },
    });

  return (
    <Panel
      title={
        <span className={s.serviceHead}>
          <span className={s.serviceName} title={f.name}>
            {f.name}
          </span>
          {isWeb && <span className={s.webTag}>web page</span>}
        </span>
      }
      meta={
        <Menu
          trigger={
            <IconButton label={`More for ${f.name}`} size="sm">
              <MoreHoriz />
            </IconButton>
          }
          items={[
            { label: "Rename", onSelect: () => setRenaming(true) },
            ...(!isWeb ? [{ label: "Make this the web page", onSelect: () => draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: f.name, containerPort: f.ports.find((x) => x.container && x.proto === "tcp")?.container ?? lookup.result?.ports[0]?.port ?? sp.web.containerPort } })) }] : []),
            "separator",
            { label: "Remove service", danger: true, onSelect: remove },
          ]}
        />
      }
      flush
    >
      <ImageSection {...p} source={source} lookup={lookup} isWeb={isWeb} />
      <PortsGroup draft={draft} form={f} issues={issues} isWeb={isWeb} target={target} usedPorts={p.usedPorts} onFix={p.onFix} />
      <VolumesGroup draft={draft} form={f} issues={issues} places={p.places} onFix={p.onFix} />
      <EnvGroup draft={draft} form={f} issues={issues} imageEnv={lookup.result?.env} onFix={p.onFix} />
      <AdvancedGroup draft={draft} form={f} names={names} issues={issues} target={target} />
      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={`Rename “${f.name}”`}
        confirm="Rename"
        taken={names.filter((n) => n !== f.name)}
        initial={f.name}
        description="Other services reach it by this name (it's its hostname), so update any addresses that use the old one."
        onDone={async (name) => {
          if (name === f.name) return;
          if (secretKeys.length) await draft.renameSecrets(f.name, name);
          draft.editCompose((doc) => renameService(doc, f.name, name));
          if (isWeb) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: name } }));
        }}
      />
      {confirmNode}
    </Panel>
  );
}

/**
 * The setup step's view of a service: just what it needs to run here (its folders and its
 * settings). Ports and everything else stay in the builder.
 */
export function ServiceEssentials(p: ServiceProps) {
  const { draft, form: f, issues } = p;
  const lookup = useImageLookup(f.build ? "" : f.image);
  return (
    <Panel
      title={
        <span className={s.serviceHead}>
          <span className={s.serviceName} title={f.name}>
            {f.name}
          </span>
          <span className={s.webTag}>{f.build ? "built from the repository" : f.image}</span>
        </span>
      }
      flush
    >
      <VolumesGroup draft={draft} form={f} issues={issues} places={p.places} onFix={p.onFix} />
      <EnvGroup draft={draft} form={f} issues={issues} imageEnv={lookup.result?.env} onFix={p.onFix} />
    </Panel>
  );
}

/** The image (with what the registry says it needs), or the build settings for repository apps. */
function ImageSection({ draft, form: f, issues, target, source, lookup, isWeb }: ServiceProps & { source: BuilderSource; lookup: ImageLookupState; isWeb: boolean }) {
  const base = `services.${f.name}`;
  const edit = draft.editCompose;
  const r = lookup.result;
  const webPort = r ? pickWebPort(r.ports) : null;
  const newPorts = r ? r.ports.filter((x) => !f.ports.some((q) => q.container === x.port) && !(isWeb && x.port === (draft.spec.web.containerPort ?? webPort))) : [];
  const newVols = r ? r.volumes.filter((v) => !f.volumes.some((x) => x.target === v) && !f.pendingFolders.includes(v)) : [];

  const applyHints = () => {
    edit((doc) => {
      const ports = newPorts.filter((x) => !(isWeb && x.port === webPort && target === "umbrel"));
      if (ports.length) setPorts(doc, f.name, [...f.ports, ...ports.map((x) => ({ host: x.port, container: x.port, proto: x.proto, ip: "", raw: null }))]);
      const taken = new Set(f.volumes.filter((v) => v.kind === "data").map((v) => v.source));
      const data = newVols.filter((v) => !mediaKind(v));
      const media = newVols.filter((v) => mediaKind(v));
      if (data.length) setVolumes(doc, f.name, [...f.volumes, ...data.map((v) => ({ kind: "data" as const, source: dataFolderFor(v, taken), target: v, readOnly: false, raw: null, long: false }))]);
      if (media.length) setPendingFolders(doc, f.name, [...f.pendingFolders, ...media]);
    });
    if (isWeb && webPort && !draft.spec.web.containerPort) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, containerPort: webPort, port: sp.web.port ?? webPort } }));
  };

  if (f.build) {
    return (
      <section className={s.group} data-field={`${base}.image`}>
        <div className={s.groupHead}>
          <h3 className={s.groupTitle}>Built from the repository</h3>
          {source !== "github" && <span className={s.note} data-level="error">Only apps from GitHub can build.</span>}
        </div>
        <div className={s.twoCol}>
          <Field label="Folder" description="Relative to the app's folder in the repository." error={errorAt(issues, `${base}.build`)}>
            <Input value={f.build.context} mono onChange={(e) => edit((doc) => setBuild(doc, f.name, { ...f.build!, context: e.target.value }))} placeholder="." />
          </Field>
          <Field label="Dockerfile" optional>
            <Input value={f.build.dockerfile} mono onChange={(e) => edit((doc) => setBuild(doc, f.name, { ...f.build!, dockerfile: e.target.value }))} placeholder="Dockerfile" />
          </Field>
          <Field label="Build stage" optional description="A target in a multi-stage Dockerfile.">
            <Input value={f.build.target} mono onChange={(e) => edit((doc) => setBuild(doc, f.name, { ...f.build!, target: e.target.value }))} />
          </Field>
        </div>
        <FieldNotes issues={issuesAt(issues, `${base}.image`)} />
      </section>
    );
  }
  const asks = [newPorts.length ? `port${newPorts.length > 1 ? "s" : ""} ${newPorts.map((x) => x.port).join(", ")}` : null, newVols.length ? `folder${newVols.length > 1 ? "s" : ""} ${newVols.join(", ")}` : null].filter(Boolean);
  return (
    <section className={s.group} data-field={`${base}.image`}>
      <ImageField value={f.image} onChange={(v) => edit((doc) => setImage(doc, f.name, v))} lookup={lookup} error={errorAt(issues, `${base}.image`)}>
        {r?.exists && asks.length > 0 && (
          <div className={s.imageStatus}>
            <span>The image also asks for {asks.join(" and ")}.</span>
            <button type="button" className={s.link} onClick={applyHints}>
              Add {newPorts.length + newVols.length > 1 ? "them" : "it"}
            </button>
          </div>
        )}
      </ImageField>
      <FieldNotes issues={issuesAt(issues, `${base}.image`)} />
    </section>
  );
}
