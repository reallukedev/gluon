"use client";
import * as React from "react";
import type { AppDetails, BuilderTarget, CustomAppDetail, Issue, WebSettings } from "@/lib/builder-types";
import { CATEGORIES } from "@/lib/builder-types";
import { Panel } from "@/components/ui/Surface";
import { Field, Input, TextArea, Switch } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { slugify, umbrelAppId } from "@/lib/builder/names";
import type { ServiceForm } from "@/lib/builder/compose";
import { IconPicker } from "./IconPicker";
import { linkHost } from "./state";
import { FieldNotes, errorAt, issuesAt } from "./Issues";
import type { Draft } from "./state";
import s from "./builder.module.css";

interface Props {
  draft: Draft;
  detail: CustomAppDetail;
  services: ServiceForm[];
  issues: Issue[];
  target: BuilderTarget;
  storeId: string | null;
  usedPorts: Map<number, string>;
}

export function DetailsTab({ draft, detail, services, issues, target, storeId }: Props) {
  const d = draft.spec.details;
  const published = detail.status === "published";
  const setD = (patch: Partial<AppDetails>) => draft.setSpec((sp) => ({ ...sp, details: { ...sp.details, ...patch } }));
  const setW = (patch: Partial<WebSettings>) => draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, ...patch } }));
  // The id follows the name until someone edits it (and never changes once published).
  const followsName = !published && d.slug === slugify(d.name);
  const appId = detail.appId ?? (target === "umbrel" ? umbrelAppId(storeId ?? "gluon", d.slug) : d.slug);
  const avatar = detail.github ? `https://github.com/${detail.github.owner}.png?size=256` : null;

  return (
    <>
      <Panel title="About">
        <div className={s.twoCol}>
          <div data-field="details.name">
            <Field label="Name" error={errorAt(issues, "details.name")}>
              <Input value={d.name} maxLength={80} onChange={(e) => setD({ name: e.target.value, ...(followsName ? { slug: slugify(e.target.value) } : {}) })} />
            </Field>
            <FieldNotes issues={issuesAt(issues, "details.name")} />
          </div>
          <div data-field="details.slug">
            <Field
              label="App id"
              description={published ? `Umbrel knows it as ${appId}. It stays the same for good.` : target === "umbrel" ? `Umbrel will know it as ${appId}. It can't change once published.` : `Its folder and project name: ${appId}.`}
              error={errorAt(issues, "details.slug")}
            >
              <Input value={d.slug} mono readOnly={published} maxLength={30} spellCheck={false} autoCapitalize="off" onChange={(e) => setD({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30) })} />
            </Field>
          </div>
          <div className={s.wide} data-field="details.tagline">
            <Field label="Tagline" optional description="One line under the name in Umbrel's store." error={errorAt(issues, "details.tagline")}>
              <Input value={d.tagline} maxLength={140} onChange={(e) => setD({ tagline: e.target.value })} placeholder="Your documents, scanned and searchable" />
            </Field>
          </div>
          <div className={s.wide} data-field="details.icon">
            <Field label="Icon">
              <IconPicker value={d.icon} name={d.name} onChange={(icon) => setD({ icon })} suggestions={avatar && d.icon !== avatar ? [{ label: "Use the owner's avatar", value: avatar }] : []} />
            </Field>
            <FieldNotes issues={issuesAt(issues, "details.icon")} errors />
          </div>
          <div data-field="details.category">
            <Field label="Category">
              <Select className={s.fill} value={CATEGORIES.some((c) => c.value === d.category) ? d.category : "other"} onChange={(category) => setD({ category })} options={CATEGORIES} />
            </Field>
          </div>
          <div data-field="details.version">
            <Field label="Version" description={detail.publishedVersion ? (detail.nextVersion === d.version ? `The next publish is ${detail.nextVersion}.` : `Unchanged, so the next publish is ${detail.nextVersion}.`) : "Umbrel shows it and offers an update whenever it changes."} error={errorAt(issues, "details.version")}>
              <Input value={d.version} mono maxLength={64} onChange={(e) => setD({ version: e.target.value })} placeholder="1.0.0" />
            </Field>
          </div>
          <div className={s.wide} data-field="details.description">
            <Field label="Description" optional error={errorAt(issues, "details.description")}>
              <TextArea value={d.description} rows={5} maxLength={6000} onChange={(e) => setD({ description: e.target.value })} placeholder="What it does, and anything someone opening it for the first time should know." />
            </Field>
          </div>
          {published && target === "umbrel" && (
            <div className={s.wide} data-field="details.releaseNotes">
              <Field label="What's new in this version" optional description="Umbrel shows this with the update." error={errorAt(issues, "details.releaseNotes")}>
                <TextArea value={d.releaseNotes} rows={3} maxLength={2000} onChange={(e) => setD({ releaseNotes: e.target.value })} />
              </Field>
            </div>
          )}
          <div data-field="details.website">
            <Field label="Website" optional error={errorAt(issues, "details.website")}>
              <Input value={d.website} type="url" inputMode="url" onChange={(e) => setD({ website: e.target.value })} placeholder="https://" />
            </Field>
          </div>
          <div data-field="details.support">
            <Field label="Where to get help" optional error={errorAt(issues, "details.support")}>
              <Input value={d.support} type="url" inputMode="url" onChange={(e) => setD({ support: e.target.value })} placeholder="https://" />
            </Field>
          </div>
          <div data-field="details.developer">
            <Field label="Made by" optional>
              <Input value={d.developer} maxLength={80} onChange={(e) => setD({ developer: e.target.value })} placeholder="You" />
            </Field>
          </div>
        </div>
      </Panel>
      <WebPanel draft={draft} detail={detail} services={services} issues={issues} target={target} setW={setW} />
    </>
  );
}

function WebPanel({ draft, detail, services, issues, target, setW }: { draft: Draft; detail: CustomAppDetail; services: ServiceForm[]; issues: Issue[]; target: BuilderTarget; setW: (p: Partial<WebSettings>) => void }) {
  const w = draft.spec.web;
  const svc = services.find((x) => x.name === w.service) ?? null;
  const hostNet = !!svc?.hostNetwork;
  const containerPorts = svc ? [...new Set(svc.ports.map((p) => p.container).filter((p): p is number => !!p))] : [];
  const host = linkHost(detail);
  const url = w.service && w.port ? `http://${host}:${hostNet ? w.containerPort ?? w.port : w.port}${w.path || ""}` : null;
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\D/g, "").slice(0, 5)) || null);

  return (
    <Panel title="Web page" meta={url ? <a className={`${s.mono} ${s.link}`} href={url} target="_blank" rel="noopener noreferrer">{url.replace(/^http:\/\//, "")}</a> : undefined}>
      <div className={s.twoCol}>
        <div className={s.wide} data-field="web.service">
          <Field label="Served by" description={w.service ? undefined : target === "umbrel" ? "Without one, the tile in Umbrel doesn't open anything." : "Without one, Gluon has no link to open."} error={errorAt(issues, "web.service")}>
            <Select
              className={s.fill}
              value={w.service ?? ""}
              onChange={(v) => {
                const next = services.find((x) => x.name === v);
                const cp = next?.ports.find((p) => p.container && p.proto === "tcp")?.container ?? w.containerPort;
                setW({ service: v || null, containerPort: v ? cp ?? null : null, port: v ? w.port ?? cp ?? null : w.port });
              }}
              options={[...services.map((x) => ({ value: x.name, label: x.name, description: x.image || (x.build ? "Built from the repository" : undefined) })), { value: "", label: "No web page" }]}
            />
          </Field>
        </div>
        {w.service && (
          <>
            <div data-field="web.containerPort">
              <Field label="It listens on" description={containerPorts.length ? `Its ports: ${containerPorts.join(", ")}` : "The port inside the container."} error={errorAt(issues, "web.containerPort")}>
                <Input value={w.containerPort ?? ""} inputMode="numeric" mono onChange={(e) => setW({ containerPort: num(e.target.value), ...(hostNet ? { port: num(e.target.value) } : {}) })} placeholder="8080" />
              </Field>
            </div>
            <div data-field="web.port">
              <Field
                label="Opens on port"
                description={hostNet ? "It uses the server's network, so it opens on its own port." : target === "umbrel" ? "Umbrel's proxy listens here and passes visitors on." : "Published on this server."}
                error={errorAt(issues, "web.port")}
              >
                <Input value={(hostNet ? w.containerPort : w.port) ?? ""} inputMode="numeric" mono readOnly={hostNet} onChange={(e) => setW({ port: num(e.target.value) })} placeholder="8080" />
              </Field>
              <FieldNotes issues={issuesAt(issues, "web.port")} />
            </div>
            <div data-field="web.path">
              <Field label="Path" optional description="Where the tile opens, like /admin." error={errorAt(issues, "web.path")}>
                <Input value={w.path} mono onChange={(e) => setW({ path: e.target.value.trim() })} placeholder="/" />
              </Field>
            </div>
            {target === "umbrel" && !hostNet && (
              <div className={s.wide}>
                <div className={s.inlineControl}>
                  <span id="umbrel-auth">
                    Ask for the Umbrel password first
                    <span className={s.hint} style={{ display: "block" }}>
                      Turn this off if the app has its own sign-in, or if apps on your phone connect to it directly.
                    </span>
                  </span>
                  <Switch checked={w.umbrelAuth} onChange={(umbrelAuth) => setW({ umbrelAuth })} aria-labelledby="umbrel-auth" />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
