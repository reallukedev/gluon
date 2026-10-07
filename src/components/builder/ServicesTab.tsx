"use client";
import * as React from "react";
import { Plus } from "iconoir-react";
import type { BuilderSource, BuilderTarget, Issue } from "@/lib/builder-types";
import type { Places } from "@/lib/files-types";
import { useApi } from "@/lib/client/api";
import { Notice, Empty } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { addService, type ServiceForm } from "@/lib/builder/compose";
import { issuesAt } from "./Issues";
import type { Draft } from "./state";
import { NameDialog } from "./services/NameDialog";
import { ServiceEditor } from "./services/ServiceEditor";
import s from "./builder.module.css";

interface Props {
  draft: Draft;
  services: ServiceForm[];
  issues: Issue[];
  target: BuilderTarget;
  source: BuilderSource;
  yamlBroken: boolean;
  usedPorts: Map<number, string>;
  onFix: (fixId: string) => void;
  onOpenCompose: () => void;
}

/** Every service of the app, edited as a form that writes into the compose file. */
export function ServicesTab({ draft, services, issues, target, source, yamlBroken, usedPorts, onFix, onOpenCompose }: Props) {
  const [adding, setAdding] = React.useState(false);
  const { data: places } = useApi<Places>("/api/files/places", { revalidateOnFocus: false });
  if (yamlBroken) {
    return (
      <Notice tone="fault" title="The compose file has an error" action={<Button size="sm" onClick={onOpenCompose}>Open Compose</Button>}>
        Fix it in Compose first. The form can only edit a file it can read.
      </Notice>
    );
  }
  const names = services.map((x) => x.name);
  return (
    <>
      {services.length === 0 && (
        <Empty title="No services yet" action={<Button icon={<Plus />} onClick={() => setAdding(true)}>Add a service</Button>}>
          A service is one container. Most apps need one; some add a database or a cache.
        </Empty>
      )}
      {services.map((f) => (
        <ServiceEditor key={f.name} draft={draft} form={f} names={names} issues={issuesAt(issues, `services.${f.name}`, true)} target={target} source={source} places={places} usedPorts={usedPorts} onFix={onFix} />
      ))}
      {services.length > 0 && (
        <div className={s.addService}>
          <Button icon={<Plus />} onClick={() => setAdding(true)}>
            Add a service
          </Button>
        </div>
      )}
      <NameDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add a service"
        confirm="Add service"
        taken={names}
        initial={names.length ? (names.includes("db") ? "" : "db") : "app"}
        onDone={(name) => {
          draft.editCompose((doc) => addService(doc, name));
          if (!draft.spec.web.service && !names.length) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: name } }));
        }}
      />
    </>
  );
}
