"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, MoreHoriz, OpenNewWindow, Copy, EditPencil, Download, Upload } from "iconoir-react";
import { Page, PageHeader, Panel, Empty, Skeleton, Notice } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { copyText } from "@/lib/client/clipboard";
import { formatBytes, plural } from "@/lib/format";
import type { SiteSummary, SitesList } from "@/lib/sites-types";
import { NewSiteDialog, type StartWith } from "./NewSiteDialog";
import { SITE_STATE, useSites } from "./client";
import s from "./sites.module.css";

const bare = (url: string) => url.replace(/^https?:\/\//, "");

function summaryOf(sites: SiteSummary[]): React.ReactNode {
  const live = sites.filter((x) => x.state === "live").length;
  const pending = sites.filter((x) => (x.state === "live" || x.state === "off") && x.changes);
  const broken = sites.filter((x) => x.state === "broken");
  return (
    <>
      <b>{sites.length === 1 ? (live ? `${sites[0]!.name} is live.` : sites[0]!.state === "draft" ? `${sites[0]!.name} isn't published yet.` : `${sites[0]!.name} isn't live.`) : live === sites.length ? `All ${sites.length} sites are live.` : `${live} of ${sites.length} sites ${live === 1 ? "is" : "are"} live.`}</b>
      {broken.length === 1 && ` ${broken[0]!.name} isn't serving anything. Publish it again.`}
      {broken.length > 1 && ` ${broken.length} aren't serving anything. Publish them again.`}
      {pending.length === 1 && ` ${pending[0]!.name} has changes you haven't published.`}
      {pending.length > 1 && ` ${pending.length} have changes you haven't published.`}
    </>
  );
}

export function SitesView({ initial }: { initial?: SitesList }) {
  const { data, error, mutate } = useSites(initial);
  const [create, setCreate] = React.useState<StartWith | null>(null);
  const router = useRouter();
  const sites = data?.sites ?? null;
  const base = data?.baseDomain ?? "server.example.com";

  return (
    <Page>
      <PageHeader
        title="Sites"
        summary={sites === null ? undefined : sites.length ? summaryOf(sites) : <b>No sites yet.</b>}
        actions={
          sites?.length ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreate("starter")}>
              New site
            </Button>
          ) : undefined
        }
      />
      {error && !data && (
        <Notice tone="fault" title="Couldn't load your sites" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      )}
      {sites === null && !error ? (
        <Panel flush>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={s.row} aria-hidden>
              <span className={s.colSite}>
                <Skeleton width="38%" height={14} />
                <Skeleton width="56%" height={12} style={{ marginTop: 7 }} />
              </span>
              <span className={s.colState}>
                <Skeleton width={70} height={12} />
              </span>
              <span className={s.colWhen}>
                <Skeleton width={110} height={12} />
              </span>
              <span className={s.colSize}>
                <Skeleton width={70} height={12} />
              </span>
              <span />
            </div>
          ))}
        </Panel>
      ) : sites && !sites.length ? (
        <Panel>
          <Empty
            title="Put a web page on the internet"
            action={
              <>
                <Button variant="primary" icon={<Plus />} onClick={() => setCreate("starter")}>
                  Start with a simple page
                </Button>
                <Button icon={<Upload />} onClick={() => setCreate("files")}>
                  Upload a site
                </Button>
              </>
            }
          >
            Start from a simple page or upload your own. It gets an address like <span className="mono">blog.{base}</span>.
          </Empty>
        </Panel>
      ) : sites ? (
        <Panel flush className="appear">
          <div role="table" aria-label="Sites">
            <div role="row" className={`${s.row} ${s.head}`}>
              <span role="columnheader" className={s.colSite}>
                Site and address
              </span>
              <span role="columnheader" className={s.colState}>
                State
              </span>
              <span role="columnheader" className={s.colWhen}>
                Last published
              </span>
              <span role="columnheader" className={s.colSize}>
                Size
              </span>
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
            <div role="rowgroup">
              {sites.map((x) => (
                <SiteRow key={x.id} site={x} onOpen={() => router.push(`/sites/${x.id}`)} />
              ))}
            </div>
          </div>
        </Panel>
      ) : null}
      {create && (
        <NewSiteDialog
          open
          start={create}
          baseDomain={base}
          onOpenChange={(o) => !o && setCreate(null)}
          onCreated={(id) => {
            void mutate();
            router.push(`/sites/${id}`);
          }}
        />
      )}
    </Page>
  );
}

function SiteRow({ site: x, onOpen }: { site: SiteSummary; onOpen: () => void }) {
  const st = SITE_STATE[x.state];
  const url = x.address?.url ?? null;
  const copy = () => url && void copyText(url).then((ok) => (ok ? toast.success("Address copied", { description: bare(url) }) : toast.error("Couldn't copy", { description: url })));
  return (
    <div
      role="row"
      className={`${s.row} ${s.siteRow}`}
      data-off={x.state === "off" || x.state === "draft" ? "" : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        onOpen();
      }}
    >
      <span role="cell" className={s.colSite}>
        <Link href={`/sites/${x.id}`} className={s.siteName}>
          {x.name}
        </Link>
        {url ? (
          x.state === "live" ? (
            <a className={s.url} href={url} target="_blank" rel="noopener noreferrer">
              {bare(url)}
            </a>
          ) : (
            <span className={s.urlOff}>{bare(url)}</span>
          )
        ) : (
          <span className={s.sub}>No address yet</span>
        )}
      </span>
      <span role="cell" className={s.colState}>
        <StateLine state={st.line} label={st.label} />
        {x.changes && (x.state === "live" || x.state === "off") && <span className={s.sub}>Unpublished changes</span>}
      </span>
      <span role="cell" className={s.colWhen}>
        {x.live?.at ? (
          <>
            <Time ts={x.live.at} />
            {x.live.by && <span className={s.sub}>by {x.live.by}</span>}
          </>
        ) : (
          <span className={s.sub}>Never</span>
        )}
      </span>
      <span role="cell" className={`${s.colSize} num`}>
        {formatBytes(x.draft.bytes)}
        <span className={s.sub}>{plural(x.draft.files, "file")}</span>
      </span>
      <span role="cell" className={s.colMenu}>
        <Menu
          trigger={
            <IconButton label={`${x.name} actions`} size="sm">
              <MoreHoriz />
            </IconButton>
          }
          items={[
            { label: "Edit", icon: <EditPencil />, href: `/sites/${x.id}` },
            ...(url ? [{ label: "Open the site", icon: <OpenNewWindow />, disabled: x.state !== "live", onSelect: () => window.open(url, "_blank", "noopener") }, { label: "Copy address", icon: <Copy />, onSelect: copy }] : []),
            { label: "Download as .zip", icon: <Download />, onSelect: () => (window.location.href = `/api/sites/${x.id}/zip`) },
          ]}
        />
      </span>
    </div>
  );
}
