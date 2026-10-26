"use client";
import * as React from "react";
import { mutate as mutateGlobal } from "swr";
import type { LeftoverT, NeedStateT, RouterStatus } from "@/lib/router-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Button, LinkButton } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import s from "./forwarding.module.css";

const URL = "/api/network/router";
/** The router page reads this too: connecting or forgetting changes what it can do. */
const OVERVIEW = "/api/network/router/overview";
const quiet = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";
const ports = (n: Pick<NeedStateT["need"], "protocol" | "min" | "max">) => `${n.protocol === "both" ? "TCP/UDP" : n.protocol.toUpperCase()} ${n.min === n.max ? n.min : `${n.min}-${n.max}`}`;

function State({ st, server }: { st: NeedStateT; server: string }) {
  if (st.status === "forwarded") return <StateLine state="running" label={`Forwarded to ${st.device ?? server}`} />;
  if (st.status === "elsewhere") return <StateLine state="attention" label={`Goes to ${st.device}`} />;
  if (st.status === "missing") return <StateLine state="attention" label="Not forwarded" />;
  return <StateLine state="unknown" label="Not checked" />;
}

/**
 * Network → Port forwarding: the ports Gluon's apps need from the internet and, on routers Gluon
 * can manage (AT&T BGW gateways), whether each is forwarded to this server, with the fix one click
 * away. On other routers it's the list to set up by hand.
 */
export function PortForwarding({ onRouterPage }: { onRouterPage?: boolean } = {}) {
  const { data, error, mutate, isLoading } = useApi<RouterStatus>(URL, { refresh: 120_000 });
  const [connecting, setConnecting] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();

  async function fix(keys: string[] | null) {
    setBusy(keys?.[0] ?? "all");
    try {
      const r = await api.post<{ done: string[]; status: RouterStatus }>(URL, { keys });
      await mutate(r.status, { revalidate: false });
      toast.success(r.done.length ? "Your router is updated" : "Everything was already forwarded", r.done.length ? { description: r.done.join(". ") + "." } : undefined);
    } catch (e) {
      if (!quiet(e)) toast.error("The router wasn't changed", { description: e instanceof Error ? e.message : undefined, timeout: 10_000 });
      void mutate();
    } finally {
      setBusy(null);
    }
  }

  const stop = (st: NeedStateT) =>
    confirm({
      title: `Stop forwarding ${st.need.label}?`,
      consequences: [`${st.need.why.replace(/\.$/, "")} stops working from outside your home.`, `Gluon removes the forward and the "${st.service}" service it made on the router.`],
      confirmLabel: "Stop forwarding",
      variant: "danger",
      onConfirm: async () => {
        try {
          await mutate(await api.del<RouterStatus>(URL, { key: st.need.key }), { revalidate: false });
          toast.success(`Stopped forwarding ${st.need.label}`);
        } catch (e) {
          if (!quiet(e)) throw e;
        }
      },
    });

  const stopLeftover = (l: LeftoverT) =>
    confirm({
      title: `Remove "${l.service}" from the router?`,
      consequences: [`Nothing on this server uses ${ports(l)} any more.`, l.device ? `Gluon removes its forward to ${l.device}, then the service.` : "Gluon removes the service it made."],
      confirmLabel: "Remove from the router",
      variant: "danger",
      onConfirm: async () => {
        try {
          await mutate(await api.del<RouterStatus>(URL, { service: l.service }), { revalidate: false });
          toast.success(`Removed ${l.service} from the router`);
        } catch (e) {
          if (!quiet(e)) throw e;
        }
      },
    });

  const forget = () =>
    confirm({
      title: "Remove the router's access code from Gluon?",
      consequences: ["Port forwarding on the router stays as it is.", "Gluon stops checking it and can't fix it until you connect again."],
      confirmLabel: "Remove access code",
      onConfirm: async () => {
        await api.del<{ forgotten: string[] }>(URL, {});
        void mutate();
        void mutateGlobal(OVERVIEW);
      },
    });

  const missing = data?.needs.filter((n) => n.status === "missing") ?? [];
  const router = data?.model ? `${data.model}${data.gateway ? ` at ${data.gateway}` : ""}` : data?.gateway ? `Router at ${data.gateway}` : null;
  const server = data?.server.name ?? "this server";

  return (
    <Panel
      id="port-forwarding"
      title="Port forwarding"
      meta={
        data?.connected && missing.length > 0 ? (
          <Button size="sm" variant="primary" loading={busy === "all"} disabled={!!busy} onClick={() => void fix(null)}>
            Forward {missing.length === 1 ? "the missing port" : `${missing.length} missing`}
          </Button>
        ) : router ? (
          <span className={s.muted}>{router}</span>
        ) : undefined
      }
      flush
    >
      {!data ? (
        error ? (
          <div className={s.pad}>
            <Notice tone="fault" title="Gluon couldn't check port forwarding">
              {error.message}
            </Notice>
          </div>
        ) : (
          <div className={s.pad}>{isLoading && <Skeleton height={120} radius={8} />}</div>
        )
      ) : (
        <>
          <div className={s.lead}>
            {data.connected ? (
              <p>
                {missing.length === 0 && !data.error
                  ? `Everything your apps need from the internet reaches ${server}${router ? ` through your ${data.model}` : ""}.`
                  : `Gluon reads your ${data.model} and adds what's missing, pointing it at ${server}${data.server.ip ? ` (${data.server.ip})` : ""}.`}
              </p>
            ) : data.supported ? (
              <>
                <p>
                  Gluon can set these up on your {data.model}. It needs the router&rsquo;s Device Access Code, printed on its label, once.
                </p>
                <Button size="sm" onClick={() => setConnecting(true)}>
                  Connect with the access code
                </Button>
              </>
            ) : (
              <p>
                Forward these on your router to {data.server.ip ?? "this server"}. {data.gateway ? `Its settings are usually at http://${data.gateway}.` : ""} Gluon can do it for you on AT&amp;T BGW gateways.
              </p>
            )}
          </div>
          {data.codeRejected ? (
            <div className={s.pad}>
              <Notice
                tone="attention"
                title="The router no longer accepts the access code Gluon has"
                action={
                  <Button size="sm" onClick={() => setConnecting(true)}>
                    Enter it again
                  </Button>
                }
              >
                Gluon stopped signing in with it, so the router doesn&rsquo;t lock sign-ins out. Port forwarding stays as it is until you enter the code again.
              </Notice>
            </div>
          ) : data.error ? (
            <div className={s.pad}>
              <Notice tone="attention" title="Gluon couldn't read your router">
                {data.error}
              </Notice>
            </div>
          ) : null}
          {data.needs.length === 0 ? (
            <p className={`${s.pad} ${s.muted}`}>Nothing on this server needs a port forwarded yet.</p>
          ) : (
            <ul className={s.list}>
              {data.needs.map((st) => (
                <li key={st.need.key} className={s.row}>
                  <span className={s.what}>
                    <span className={s.name}>{st.need.label}</span>
                    <span className={s.why}>{st.need.why}</span>
                  </span>
                  <span className={`${s.ports} mono`}>
                    {ports(st.need)}
                    {!data.connected && <CopyButton value={ports(st.need)} size="sm" label={`Copy ${ports(st.need)}`} />}
                  </span>
                  <span className={s.state}>
                    <State st={st} server={server} />
                    {st.status === "elsewhere" && <span className={s.why}>Change it on the router if it should come here.</span>}
                  </span>
                  <span className={s.act}>
                    {data.connected && st.status === "missing" && (
                      <Button size="sm" loading={busy === st.need.key} disabled={!!busy} onClick={() => void fix([st.need.key])}>
                        Forward
                      </Button>
                    )}
                    {data.connected && st.status === "forwarded" && st.ours && (
                      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => stop(st)}>
                        Stop
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.leftovers.length > 0 && (
            <>
              <p className={s.subhead}>Gluon set these up, and nothing needs them now</p>
              <ul className={s.list}>
                {data.leftovers.map((l) => (
                  <li key={l.service} className={s.row}>
                    <span className={s.what}>
                      <span className={s.name}>{l.service}</span>
                      <span className={s.why}>The app or address that needed it is gone.</span>
                    </span>
                    <span className={`${s.ports} mono`}>{ports(l)}</span>
                    <span className={s.state}>
                      <StateLine state={l.device ? "attention" : "stopped"} label={l.device ? `Still goes to ${l.device}` : "Not forwarded"} />
                    </span>
                    <span className={s.act}>
                      <Button size="sm" onClick={() => stopLeftover(l)}>
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {(data.connected || (!onRouterPage && data.gateway)) && (
            <div className={s.foot}>
              {!onRouterPage && data.gateway && (
                <LinkButton href="/network/router" size="sm" variant="ghost">
                  Open the router page
                </LinkButton>
              )}
              {data.connected && (
                <Button size="sm" variant="ghost" onClick={forget}>
                  Remove the access code
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {confirmNode}
      <ConnectDialog open={connecting} onOpenChange={setConnecting} model={data?.model ?? "router"} gateway={data?.gateway ?? ""} onConnected={(st) => void mutate(st, { revalidate: false })} />
    </Panel>
  );
}

/** Asks for the Device Access Code once; Network and the router page both open it. */
export function ConnectDialog({ open, onOpenChange, model, gateway, onConnected }: { open: boolean; onOpenChange: (o: boolean) => void; model: string; gateway: string; onConnected: (st: RouterStatus) => void }) {
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setCode("");
      setErr(null);
    }
  }, [open]);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const st = await api.put<RouterStatus>(URL, { code: code.trim() });
      onConnected(st);
      void mutateGlobal(URL, st, { revalidate: false });
      void mutateGlobal(OVERVIEW);
      toast.success(`Connected to your ${model}`);
      onOpenChange(false);
    } catch (e) {
      if (!quiet(e)) setErr(e instanceof Error ? e.message : "Gluon couldn't sign in to the router.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Connect your router"
      description={`Gluon signs in to your ${model}${gateway ? ` at ${gateway}` : ""} the way your browser does, to forward ports and restart it when you ask.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!code.trim()} onClick={() => void go()}>
            Connect
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) void go();
        }}
      >
        <Field label="Device Access Code" error={err} description="Printed on the label on the side of the router. Gluon saves it encrypted on this server, so you enter it once and nobody else who manages Gluon has to. It's only used to sign in to the router.">
          <Input type="password" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" mono autoFocus maxLength={32} />
        </Field>
      </form>
    </Dialog>
  );
}
