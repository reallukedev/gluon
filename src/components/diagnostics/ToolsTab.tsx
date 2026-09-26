"use client";
import * as React from "react";
import Link from "next/link";
import type { DnsToolResult, HttpHop, HttpToolResult, PingToolResult, PortToolResult, TracerouteToolResult } from "@/lib/diagnostics-types";
import { api, ApiError } from "@/lib/client/api";
import { Panel, Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Input, Segmented, Checkbox } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { StateLine } from "@/components/ui/StateLine";
import s from "./diagnostics.module.css";

function useTool<T>(url: string) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const run = async (body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      setData(await api.post<T>(url, body));
    } catch (e) {
      setData(null);
      setError({ message: e instanceof Error ? e.message : "That didn't work.", field: e instanceof ApiError ? e.field : undefined });
    } finally {
      setBusy(false);
    }
  };
  return { data, error, busy, run };
}

function CopyResult({ text }: { text: string }) {
  return <CopyButton value={text} label="Copy the result" />;
}

export function ToolsTab() {
  return (
    <div className={s.tools}>
      <p className={`${s.toolWide} ${s.faint}`}>
        Each tool runs once, from this server. To track down a problem step by step, use a <Link href="/diagnostics">checkup</Link> instead.
      </p>
      <DnsTool />
      <PingTool />
      <PortTool />
      <TraceTool />
      <HttpTool />
    </div>
  );
}

// ---------------------------------------------------------------- DNS

const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"] as const;

function DnsTool() {
  const t = useTool<DnsToolResult>("/api/diagnostics/tools/dns");
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<(typeof TYPES)[number]>("A");
  const [resolver, setResolver] = React.useState("system");
  const [custom, setCustom] = React.useState("");
  const r = t.data;
  const text = r ? [`;; ${r.name} ${r.type} via ${r.resolver}: ${r.status}${r.queryMs !== null ? ` (${r.queryMs} ms)` : ""}`, ...r.answers.map((a) => `${a.name}\t${a.ttl}\t${a.type}\t${a.data}`)].join("\n") : "";
  return (
    <Panel title="DNS lookup" meta={r ? <CopyResult text={text} /> : undefined}>
      <form
        className={s.toolForm}
        onSubmit={(e) => {
          e.preventDefault();
          void t.run({ name, type, resolver: resolver === "custom" ? custom : resolver });
        }}
      >
        <Field label="Name" error={t.error?.field === "name" ? t.error.message : null}>
          <Input value={name} onChange={(e) => setName(e.target.value)} mono placeholder="media.example.com" spellCheck={false} autoCapitalize="off" required />
        </Field>
        <div className={s.toolRow}>
          <Field label="Record">
            <Select aria-label="Record type" value={type} onChange={setType} options={TYPES.map((x) => ({ value: x, label: x }))} />
          </Field>
          <Field label="Ask">
            <Select
              aria-label="Resolver"
              value={resolver}
              onChange={setResolver}
              options={[
                { value: "system", label: "This server's resolver" },
                { value: "cloudflare", label: "Cloudflare (1.1.1.1)" },
                { value: "google", label: "Google (8.8.8.8)" },
                { value: "quad9", label: "Quad9 (9.9.9.9)" },
                { value: "custom", label: "Another server…" },
              ]}
            />
          </Field>
        </div>
        {resolver === "custom" && (
          <Field label="Resolver address" error={t.error?.field === "resolver" ? t.error.message : null}>
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} mono placeholder="192.168.1.254" required />
          </Field>
        )}
        <Button type="submit" loading={t.busy} className={s.toolGo}>
          Look up
        </Button>
      </form>
      {t.error && !t.error.field && <Notice tone="fault">{t.error.message}</Notice>}
      {r && (
        <div className={s.result}>
          <StateLine state={r.status === "NOERROR" && r.answers.length ? "running" : r.status === "NOERROR" || r.status === "NXDOMAIN" ? "stopped" : "unhealthy"} label={r.message} />
          {r.answers.length > 0 && (
            <table className={s.resultTable}>
              <tbody>
                {r.answers.map((a, i) => (
                  <tr key={i}>
                    <td className="mono">{a.type}</td>
                    <td className="mono">{a.data}</td>
                    <td className={`${s.faint} num`} title="Time to live">
                      {a.ttl}s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={s.resultFoot}>
            {r.server ? <>Answered by <span className="mono">{r.server}</span></> : `Asked ${r.resolver}`}
            {r.queryMs !== null ? ` in ${r.queryMs} ms` : ""}.
          </p>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- ping

function PingTool() {
  const t = useTool<PingToolResult>("/api/diagnostics/tools/ping");
  const [host, setHost] = React.useState("");
  const [count, setCount] = React.useState("4");
  const r = t.data;
  const max = r ? Math.max(1, ...r.replies.map((x) => x.ms)) : 1;
  const text = r ? [`ping ${r.host}${r.address ? ` (${r.address})` : ""}`, ...r.replies.map((x) => `seq=${x.seq} ttl=${x.ttl ?? "?"} time=${x.ms} ms`), `${r.transmitted} sent, ${r.received} received, ${r.lossPct}% loss`, r.rtt ? `min/avg/max = ${r.rtt.min}/${r.rtt.avg}/${r.rtt.max} ms` : ""].join("\n") : "";
  return (
    <Panel title="Ping" meta={r ? <CopyResult text={text} /> : undefined}>
      <form
        className={s.toolForm}
        onSubmit={(e) => {
          e.preventDefault();
          void t.run({ host, count: Number(count) });
        }}
      >
        <div className={s.toolRow}>
          <Field label="Host" error={t.error?.field === "host" ? t.error.message : null}>
            <Input value={host} onChange={(e) => setHost(e.target.value)} mono placeholder="1.1.1.1" spellCheck={false} autoCapitalize="off" required />
          </Field>
          <Field label="Times">
            <Select aria-label="Count" value={count} onChange={setCount} options={["1", "4", "10"].map((x) => ({ value: x, label: x }))} />
          </Field>
        </div>
        <Button type="submit" loading={t.busy} className={s.toolGo}>
          Ping
        </Button>
      </form>
      {t.error && !t.error.field && <Notice tone="fault">{t.error.message}</Notice>}
      {r && (
        <div className={s.result}>
          <StateLine state={r.received === 0 ? "unhealthy" : r.lossPct > 0 ? "attention" : "running"} label={r.message} />
          {r.replies.length > 0 && (
            <ol className={s.bars}>
              {r.replies.map((x) => (
                <li key={x.seq}>
                  <span className={`${s.faint} num`}>#{x.seq}</span>
                  <span className={s.barTrack}>
                    <span className={s.barFill} style={{ width: `${(x.ms / max) * 100}%` }} />
                  </span>
                  <span className="num">{x.ms} ms</span>
                </li>
              ))}
            </ol>
          )}
          {r.rtt && (
            <p className={s.resultFoot}>
              {r.address && r.address !== r.host ? <><span className="mono">{r.address}</span> · </> : null}
              fastest {r.rtt.min} ms · slowest {r.rtt.max} ms · jitter {r.rtt.mdev} ms
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- port

function PortTool() {
  const t = useTool<PortToolResult>("/api/diagnostics/tools/port");
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState("");
  const r = t.data;
  return (
    <Panel title="Port check" meta={r ? <CopyResult text={r.message} /> : undefined}>
      <form
        className={s.toolForm}
        onSubmit={(e) => {
          e.preventDefault();
          void t.run({ host, port: Number(port) });
        }}
      >
        <div className={s.toolRow}>
          <Field label="Host" error={t.error?.field === "host" ? t.error.message : null}>
            <Input value={host} onChange={(e) => setHost(e.target.value)} mono placeholder="192.168.1.10" spellCheck={false} autoCapitalize="off" required />
          </Field>
          <Field label="Port" error={t.error?.field === "port" ? t.error.message : null}>
            <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} mono inputMode="numeric" placeholder="443" required />
          </Field>
        </div>
        <Button type="submit" loading={t.busy} className={s.toolGo}>
          Check
        </Button>
      </form>
      {t.error && !t.error.field && <Notice tone="fault">{t.error.message}</Notice>}
      {r && (
        <div className={s.result}>
          <StateLine state={r.open ? "running" : "stopped"} label={r.message} />
          {r.address && r.address !== r.host && <p className={s.resultFoot}>Resolved to <span className="mono">{r.address}</span>.</p>}
          <p className={s.resultFoot}>This checks from the server itself, not from the internet.</p>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- traceroute

function TraceTool() {
  const t = useTool<TracerouteToolResult>("/api/diagnostics/tools/traceroute");
  const [host, setHost] = React.useState("");
  const r = t.data;
  const text = r ? [`traceroute ${r.host}`, ...r.hops.map((h) => `${String(h.hop).padStart(2)}  ${h.address ?? "*"}${h.host ? ` (${h.host})` : ""}  ${h.ms.map((m) => `${m} ms`).join("  ")}`)].join("\n") : "";
  return (
    <Panel title="Traceroute" meta={r?.hops.length ? <CopyResult text={text} /> : undefined}>
      <form
        className={s.toolForm}
        onSubmit={(e) => {
          e.preventDefault();
          void t.run({ host, maxHops: 20 });
        }}
      >
        <Field label="Host" error={t.error?.field === "host" ? t.error.message : null} description="Shows each router on the way. Can take up to half a minute.">
          <Input value={host} onChange={(e) => setHost(e.target.value)} mono placeholder="1.1.1.1" spellCheck={false} autoCapitalize="off" required />
        </Field>
        <Button type="submit" loading={t.busy} className={s.toolGo}>
          Trace
        </Button>
      </form>
      {t.error && !t.error.field && <Notice tone="fault">{t.error.message}</Notice>}
      {r && (
        <div className={s.result}>
          {!r.available ? (
            <Notice title="Not available on this server">{r.message}</Notice>
          ) : (
            <>
              <StateLine state={r.reached ? "running" : r.hops.length ? "attention" : "unhealthy"} label={r.message} />
              {r.hops.length > 0 && (
                <table className={s.resultTable}>
                  <tbody>
                    {r.hops.map((h) => (
                      <tr key={h.hop}>
                        <td className={`${s.faint} num`}>{h.hop}</td>
                        <td className="mono" title={h.host ?? undefined}>
                          {h.address ? (h.host ?? h.address) : <span className={s.faint}>no answer</span>}
                          {h.host && <span className={s.faint}> {h.address}</span>}
                        </td>
                        <td className="num">{h.ms.length ? `${Math.min(...h.ms)} ms` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- HTTP

function HttpTool() {
  const t = useTool<HttpToolResult>("/api/diagnostics/tools/http");
  const [url, setUrl] = React.useState("");
  const [method, setMethod] = React.useState<"GET" | "HEAD">("GET");
  const [follow, setFollow] = React.useState(true);
  const [insecure, setInsecure] = React.useState(false);
  const r = t.data;
  const maxTotal = r ? Math.max(1, ...r.hops.map((h) => h.timing.total ?? 0)) : 1;
  const text = r
    ? [
        ...r.hops.map((h) => `${h.url}\n  ${h.error ?? `HTTP/${h.httpVersion} ${h.status} ${h.statusText ?? ""}`.trim()}  dns ${h.timing.dns ?? "-"} connect ${h.timing.connect ?? "-"} tls ${h.timing.tls ?? "-"} ttfb ${h.timing.ttfb ?? "-"} total ${h.timing.total ?? "-"} ms${h.location ? `\n  → ${h.location}` : ""}`),
        r.final?.headers ? Object.entries(r.final.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n") : "",
        r.body?.text ?? "",
      ].join("\n\n")
    : "";
  return (
    <Panel title="HTTP request" meta={r ? <CopyResult text={text} /> : undefined} className={s.toolWide}>
      <form
        className={s.toolForm}
        onSubmit={(e) => {
          e.preventDefault();
          void t.run({ url: /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`, method, followRedirects: follow, insecure });
        }}
      >
        <div className={s.httpRow}>
          <Field label="Address" error={t.error?.field === "url" ? t.error.message : null}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} mono placeholder="https://media.example.com/" spellCheck={false} autoCapitalize="off" required />
          </Field>
          <Field label="Method">
            <Segmented aria-label="Method" value={method} onChange={setMethod} options={[{ value: "GET", label: "GET" }, { value: "HEAD", label: "HEAD" }]} />
          </Field>
        </div>
        <div className={s.opts}>
          <Checkbox checked={follow} onChange={setFollow}>
            Follow redirects
          </Checkbox>
          <Checkbox checked={insecure} onChange={setInsecure}>
            Ignore certificate errors
          </Checkbox>
        </div>
        <Button type="submit" loading={t.busy} className={s.toolGo}>
          Send request
        </Button>
      </form>
      {t.error && !t.error.field && <Notice tone="fault">{t.error.message}</Notice>}
      {r && (
        <div className={s.result}>
          <StateLine state={r.final?.error ? "unhealthy" : (r.final?.status ?? 0) >= 500 ? "unhealthy" : (r.final?.status ?? 0) >= 400 ? "attention" : "running"} label={r.message} />
          <ol className={s.hops}>
            {r.hops.map((h, i) => (
              <Hop key={i} h={h} max={maxTotal} />
            ))}
          </ol>
          <p className={s.waterLegend} aria-hidden>
            <span data-seg="dns">DNS</span>
            <span data-seg="connect">Connect</span>
            <span data-seg="tls">TLS</span>
            <span data-seg="wait">Waiting</span>
            <span data-seg="body">Download</span>
          </p>
          {r.tls && (
            <p className={s.resultFoot}>
              {r.tls.protocol} · {r.tls.issuer ?? "unknown issuer"}
              {r.tls.daysLeft !== null ? ` · certificate valid ${r.tls.daysLeft} more days` : ""}
              {!r.tls.trusted && r.tls.error ? <span className={s.bad}> · not trusted ({r.tls.error})</span> : ""}
            </p>
          )}
          {r.final && Object.keys(r.final.headers).length > 0 && (
            <Disclosure summary="Response headers" meta={Object.keys(r.final.headers).length}>
              <dl className={s.headers}>
                {Object.entries(r.final.headers).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="mono">{k}</dt>
                    <dd className="mono">{Array.isArray(v) ? v.join(", ") : v}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </Disclosure>
          )}
          {r.body && (r.body.binary ? <p className={s.resultFoot}>The response is binary ({r.body.contentType}); not shown.</p> : r.body.text ? (
            <div>
              <p className={s.resultFoot}>
                First {r.body.truncated ? "4 KB" : "part"} of the response{r.body.contentType ? ` (${r.body.contentType})` : ""}:
              </p>
              <pre className={s.body}>{r.body.text}</pre>
            </div>
          ) : null)}
        </div>
      )}
    </Panel>
  );
}

function Hop({ h, max }: { h: HttpHop; max: number }) {
  const t = h.timing;
  // Cumulative marks → segments.
  const marks: { seg: string; from: number; to: number }[] = [];
  let prev = 0;
  const push = (seg: string, at: number | null) => {
    if (at === null) return;
    if (at > prev) marks.push({ seg, from: prev, to: at });
    prev = Math.max(prev, at);
  };
  push("dns", t.dns);
  push("connect", t.connect);
  push("tls", t.tls);
  push("wait", t.ttfb);
  push("body", t.total);
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <li className={s.hop}>
      <div className={s.hopHead}>
        <span className={s.code} data-class={h.error ? "5xx" : h.status ? `${Math.floor(h.status / 100)}xx` : "other"}>
          {h.error ? "failed" : h.status}
        </span>
        <span className={`mono ${s.oneLine}`} title={h.url}>
          {h.url}
        </span>
        <span className={`num ${s.faint}`}>{t.total !== null ? `${t.total} ms` : ""}</span>
      </div>
      <div className={s.water} role="img" aria-label={`DNS ${t.dns ?? "–"} ms, connected at ${t.connect ?? "–"} ms, TLS done at ${t.tls ?? "–"} ms, first byte at ${t.ttfb ?? "–"} ms, done at ${t.total ?? "–"} ms`}>
        {marks.map((m) => (
          <span key={m.seg} className={s.seg} data-seg={m.seg} style={{ left: pct(m.from), width: pct(m.to - m.from) }} title={`${m.seg}: ${Math.round((m.to - m.from) * 10) / 10} ms`} />
        ))}
      </div>
      {(h.error || h.location || h.remoteAddress) && (
        <p className={s.hopSub}>
          {h.error ?? (h.location ? `→ ${h.location}` : "")}
          {h.remoteAddress ? `${h.error || h.location ? " · " : ""}${h.remoteAddress}` : ""}
        </p>
      )}
    </li>
  );
}
