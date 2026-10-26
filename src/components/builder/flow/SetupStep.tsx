"use client";
import Link from "next/link";
import type { BuilderTarget, CustomAppDetail, Issue, WebSettings } from "@/lib/builder-types";
import type { Places } from "@/lib/files-types";
import { useApi } from "@/lib/client/api";
import { Panel, Notice } from "@/components/ui/Surface";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { slugify } from "@/lib/builder/names";
import type { ServiceForm } from "@/lib/builder/compose";
import { WebPanel } from "../DetailsTab";
import { FieldNotes, errorAt, issuesAt } from "../Issues";
import type { Draft } from "../state";
import { ServiceEssentials } from "../services/ServiceEditor";
import { FlowNav } from "./FlowFrame";
import s from "../builder.module.css";
import f from "./flow.module.css";

/**
 * What the app needs to run here: its name, its web page, and for each service its folders and
 * settings (secrets included). Ports, networks and the rest stay in the full builder.
 */
export function SetupStep({ draft, detail, services, yamlBroken, issues, target, usedPorts, onFix, onNext }: { draft: Draft; detail: CustomAppDetail; services: ServiceForm[]; yamlBroken: boolean; issues: Issue[]; target: BuilderTarget; usedPorts: Map<number, string>; onFix: (id: string) => void; onNext: () => void }) {
  const { data: places } = useApi<Places>("/api/files/places", { revalidateOnFocus: false });
  const d = draft.spec.details;
  const followsName = d.slug === slugify(d.name);
  const pending = yamlBroken ? [] : services.flatMap((x) => x.pendingFolders);
  const setW = (patch: Partial<WebSettings>) => draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, ...patch } }));
  const setName = (name: string) => draft.setSpec((sp) => ({ ...sp, details: { ...sp.details, name, ...(followsName ? { slug: slugify(name) } : {}) } }));

  return (
    <div className={f.stack}>
      <Panel title="About">
        <div data-field="details.name">
          <Field label="Name" description={target === "umbrel" ? "What Umbrel shows under its icon." : `What it's called in Gluon. Its folder is named ${d.slug}.`} error={errorAt(issues, "details.name") ?? errorAt(issues, "details.slug")}>
            <Input value={d.name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <FieldNotes issues={issuesAt(issues, "details.name")} />
        </div>
      </Panel>
      {yamlBroken ? (
        <Notice tone="fault" title="The compose file has an error" action={<LinkButton size="sm" href={`/apps/custom/${detail.id}?tab=compose`}>Open Compose</LinkButton>}>
          Fix it in the full builder first. These settings can only edit a file Gluon can read.
        </Notice>
      ) : (
        <>
          <WebPanel draft={draft} detail={detail} services={services} issues={issues} target={target} usedPorts={usedPorts} setW={setW} />
          {services.map((svc) => (
            <ServiceEssentials key={svc.name} draft={draft} form={svc} issues={issuesAt(issues, `services.${svc.name}`, true)} target={target} places={places} usedPorts={usedPorts} onFix={onFix} />
          ))}
          <p className={s.hint}>
            Ports, networks, labels, limits and health checks are in the{" "}
            <Link className={s.link} href={`/apps/custom/${detail.id}?tab=services`}>
              full builder
            </Link>
            .
          </p>
        </>
      )}
      <FlowNav>
        {pending.length > 0 && <p className={f.navReason}>{`Choose a folder for ${pending.join(", ")} to continue.`}</p>}
        <Button variant="primary" disabled={pending.length > 0} onClick={onNext}>
          Continue
        </Button>
      </FlowNav>
    </div>
  );
}
