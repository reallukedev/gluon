"use client";
import * as React from "react";
import type { SearchHit } from "@/lib/files-types";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { KindIcon, parentOf } from "./lib";
import s from "./files.module.css";

type State = { hits: SearchHit[]; done: boolean; truncated: boolean; timedOut: boolean; error: string | null };

/** Streamed name search under the current folder (and everything inside it). */
export function SearchResults({ root, q, onOpen, onClose }: { root: string; q: string; onOpen: (hit: SearchHit) => void; onClose: () => void }) {
  const fmt = useFormat();
  const [st, setSt] = React.useState<State>({ hits: [], done: false, truncated: false, timedOut: false, error: null });

  React.useEffect(() => {
    setSt({ hits: [], done: false, truncated: false, timedOut: false, error: null });
    const es = new EventSource(`/api/files/search?${new URLSearchParams({ path: root, q, limit: "1000" })}`);
    es.addEventListener("hits", (e) => {
      const { items } = JSON.parse((e as MessageEvent).data) as { items: SearchHit[] };
      setSt((cur) => ({ ...cur, hits: [...cur.hits, ...items] }));
    });
    es.addEventListener("done", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { truncated: boolean; timedOut: boolean };
      setSt((cur) => ({ ...cur, done: true, truncated: d.truncated, timedOut: d.timedOut }));
      es.close();
    });
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      let msg = "The search stopped. Try again.";
      if (data) {
        try {
          msg = (JSON.parse(data) as { message: string }).message;
        } catch {
          /* default */
        }
      }
      setSt((cur) => (cur.done ? cur : { ...cur, done: true, error: msg }));
      es.close();
    });
    return () => es.close();
  }, [root, q]);

  return (
    <div className={s.stack}>
      <div className={s.searchHead} role="status">
        <span>
          {st.done ? (
            <>
              {fmt.plural(st.hits.length, "match", "matches")} for “{q}” in <span className="mono">{root}</span>
              {st.truncated && " — showing the first 1,000"}
            </>
          ) : (
            <>
              Searching <span className="mono">{root}</span> for “{q}”… <span className="num muted">{st.hits.length || ""}</span>
            </>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Back to folder
        </Button>
      </div>
      {st.error && <Notice tone="fault">{st.error}</Notice>}
      {st.timedOut && <Notice tone="attention">The search took longer than 30 seconds and stopped early. Search inside a smaller folder to see everything.</Notice>}
      {!st.done && !st.hits.length ? (
        <div className={s.table}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={s.searchRow}>
              <Skeleton width={`${40 + i * 12}%`} />
            </div>
          ))}
        </div>
      ) : st.done && !st.hits.length && !st.error ? (
        <Empty title={`Nothing called “${q}” here`}>Gluon looked through {root} and every folder inside it. Try part of the name, or use * as a wildcard (for example *.mkv).</Empty>
      ) : (
        <ul className={s.table} aria-label="Search results">
          {st.hits.map((h) => (
            <li key={h.path}>
              <button type="button" className={s.searchRow} onClick={() => onOpen(h)} title={h.path}>
                <KindIcon kind={h.kind} className={s.kindIcon} />
                <span className={s.nameText}>
                  <span className="truncate">{h.name}</span>
                  <span className={`${s.linkNote} mono`}>{parentOf(h.path)}</span>
                </span>
                <span className="num muted">{h.size !== null ? fmt.bytes(h.size) : ""}</span>
                <span className="num muted">
                  <Time ts={h.mtime} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
