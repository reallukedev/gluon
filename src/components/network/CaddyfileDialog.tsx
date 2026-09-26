"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { Copy } from "iconoir-react";
import type { CaddyfileResponse } from "@/lib/network-types";
import { useApi } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { copyText } from "./shared";
import { driftSentence } from "./DriftNotice";
import s from "./network.module.css";

const CodeEditor = dynamic(() => import("@/components/code/CodeEditor").then((m) => m.CodeEditor), { ssr: false, loading: () => <Skeleton height={460} radius={10} /> });

type View = "disk" | "generated" | "diff";

export function CaddyfileDialog({ open, onOpenChange, onRewrite }: { open: boolean; onOpenChange: (o: boolean) => void; onRewrite: () => Promise<unknown> }) {
  const { data, error, mutate } = useApi<CaddyfileResponse>(open ? "/api/network/caddyfile" : null);
  const [rewriting, setRewriting] = React.useState(false);
  async function rewrite() {
    setRewriting(true);
    try {
      await onRewrite();
      await mutate();
      setView("disk");
    } catch {
      /* the page reports it */
    } finally {
      setRewriting(false);
    }
  }
  const [view, setView] = React.useState<View>("disk");
  React.useEffect(() => {
    if (open && data?.drift) setView("diff");
  }, [open, data?.drift]);
  const text = view === "generated" ? (data?.generated ?? "") : (data?.text ?? "");

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Caddyfile"
      description="The web server's settings file. Gluon writes it from your addresses every time you save; change the addresses instead of the file."
      size="xwide"
      footerStart={
        data?.drift ? (
          <Segmented
            aria-label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "diff", label: "Differences" },
              { value: "disk", label: "On disk" },
              { value: "generated", label: "Gluon's version" },
            ]}
          />
        ) : undefined
      }
      footer={
        <>
          <Button
            icon={<Copy />}
            disabled={!data}
            onClick={() => void copyText(text).then((ok) => (ok ? toast.success("Copied the Caddyfile") : toast.error("Couldn't copy")))}
          >
            Copy
          </Button>
          {data?.drift ? (
            <Button variant="primary" loading={rewriting} onClick={() => void rewrite()}>
              Use Gluon&rsquo;s version
            </Button>
          ) : (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </>
      }
    >
      {error ? (
        <Notice tone="fault" title="Couldn't read the Caddyfile">{error.message}</Notice>
      ) : !data ? (
        <Skeleton height={460} radius={10} />
      ) : (
        <div className={s.caddy}>
          {data.drift && (
            <Notice tone="attention">
              {driftSentence(data.driftInfo)} Highlighted lines show what &ldquo;Use Gluon&rsquo;s version&rdquo; changes; the current file is kept in History.
            </Notice>
          )}
          {!data.text && <Notice title="There's no Caddyfile on disk yet">Gluon writes one the first time you save an address.</Notice>}
          <CodeEditor
            key={view}
            value={view === "diff" ? data.generated : text}
            original={view === "diff" ? data.text : undefined}
            language="caddyfile"
            readOnly
            height={460}
            label={view === "diff" ? "Differences between the Caddyfile on disk and Gluon's version" : "Caddyfile"}
          />
        </div>
      )}
    </Dialog>
  );
}
