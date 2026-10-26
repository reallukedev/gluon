"use client";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Panel, DefinitionList, Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import s from "./settings.module.css";

interface About {
  version: string;
  node: string;
  next: string;
  dataDir: string;
  dbSize: number;
  startedAt: number;
  mode: string;
}

export function About() {
  const { data, error, mutate } = useApi<About>("/api/about");
  const fmt = useFormat();
  if (error && !data) {
    return (
      <Notice tone="fault" title="Couldn't read Gluon's details" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
        {error.message}
      </Notice>
    );
  }
  if (!data) {
    return (
      <div className={s.stack}>
        <Skeleton height={170} radius={12} />
        <Skeleton height={150} radius={12} />
      </div>
    );
  }
  const dir = data.dataDir.replace(/\/$/, "");
  return (
    <div className={s.stack}>
      <Panel title="Gluon">
        <DefinitionList
          items={[
            ["Version", <span key="v" className="num">{data.version}</span>],
            ["Running since", <span key="t"><Time ts={data.startedAt} kind="dateTime" /> (<Time ts={data.startedAt} />)</span>],
            ["Mode", data.mode === "production" ? "Production" : "Development"],
            ["Built with", `Next.js ${data.next.replace(/^\^/, "")}, Node ${data.node.replace(/^v/, "")}, Base UI`],
          ]}
        />
      </Panel>
      <Panel title="Its data">
        <DefinitionList
          items={[
            ["Folder", <span key="d" className="mono">{dir}</span>],
            ["Database", <span key="db"><span className="mono">{dir}/gluon.db</span> · <span className="num">{fmt.bytes(data.dbSize)}</span></span>],
            ["Encryption key", <span key="k" className="mono">{dir}/secret.key</span>],
          ]}
        />
        <p className={s.hint} style={{ marginTop: 14 }}>
          Accounts, settings, alerts and history all live in this folder inside Gluon&apos;s container. There&apos;s no export button yet: to back Gluon up, include this
          folder with your apps&apos; data. Keep <span className="mono">secret.key</span> with it, or saved notification and connected-app keys can&apos;t be read after
          a restore.
        </p>
      </Panel>
      <p className={s.hint}>Nothing leaves this server unless you set up a notification channel or connect an app.</p>
    </div>
  );
}
