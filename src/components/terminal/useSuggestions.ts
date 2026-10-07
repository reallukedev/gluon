"use client";
import * as React from "react";
import { api } from "@/lib/client/api";
import { analyze, suggest, type Suggestion } from "@/lib/terminal/complete";
import { resolveDir } from "@/lib/terminal/paths";
import { loadSpec, knownSpecs } from "@/lib/terminal/specs";
import type { DirEntry, SpecNode, TargetId, TargetProbe } from "@/lib/terminal/types";

const KNOWN = new Set(knownSpecs);
const DIR_TTL = 15_000;

interface Caches {
  specs: Map<string, SpecNode | null>;
  dirs: Map<string, { at: number; entries: DirEntry[] }>;
  units: Map<string, string[]>;
  containers: Map<string, string[]>;
  inflight: Set<string>;
}

/**
 * Suggestions for the prompt. Works out what the word under the cursor needs, fetches only that
 * (a program's spec once, a folder's listing debounced and cached briefly, units and containers once
 * per visit) and ranks it all with the person's history.
 */
export function useSuggestions(o: { target: TargetId; line: string; cursor: number; probe: TargetProbe | undefined; cwd: string | null; history: string[]; enabled: boolean }) {
  const caches = React.useRef<Caches>({ specs: new Map(), dirs: new Map(), units: new Map(), containers: new Map(), inflight: new Set() });
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const line = o.line;
  const cursor = Math.min(o.cursor, line.length);
  const c = caches.current;

  const first = React.useMemo(() => analyze(line, cursor, null), [line, cursor]);
  const program = first.program;
  const spec = program ? c.specs.get(program) : undefined;
  const a = React.useMemo(() => (spec ? analyze(line, cursor, spec) : first), [first, spec, line, cursor]);
  const absDir = a.dir !== null && o.cwd ? resolveDir(o.cwd, o.probe?.home ?? null, a.dir) : null;
  const dirKey = absDir ? `${o.target}|${absDir}` : null;

  // A program's spec: fetched once, the first time it's typed.
  React.useEffect(() => {
    if (!o.enabled || !program || !KNOWN.has(program) || c.specs.has(program)) return;
    let live = true;
    void loadSpec(program).then((s) => {
      c.specs.set(program, s);
      if (live) bump();
    });
    return () => {
      live = false;
    };
  }, [o.enabled, program, c]);

  // A folder's contents: after a short pause in typing, kept for a few seconds.
  React.useEffect(() => {
    if (!o.enabled || !absDir || !dirKey) return;
    const hit = c.dirs.get(dirKey);
    if ((hit && Date.now() - hit.at < DIR_TTL) || c.inflight.has(dirKey)) return;
    const t = setTimeout(() => {
      c.inflight.add(dirKey);
      api
        .get<{ entries: DirEntry[] }>(`/api/terminal/complete?target=${encodeURIComponent(o.target)}&kind=paths&dir=${encodeURIComponent(absDir)}`)
        .then(
          (r) => c.dirs.set(dirKey, { at: Date.now(), entries: r.entries }),
          () => c.dirs.set(dirKey, { at: Date.now(), entries: [] }),
        )
        .finally(() => {
          c.inflight.delete(dirKey);
          bump();
        });
    }, 120);
    return () => clearTimeout(t);
  }, [o.enabled, o.target, absDir, dirKey, c]);

  // Units and containers: once per visit, and only on the server itself.
  const needUnits = o.enabled && a.wantsUnits && o.target === "host";
  const needContainers = o.enabled && a.wantsContainers && o.target === "host";
  React.useEffect(() => {
    for (const [want, kind, map] of [
      [needUnits, "units", c.units],
      [needContainers, "containers", c.containers],
    ] as const) {
      const k = `${kind}|${o.target}`;
      if (!want || map.has(o.target) || c.inflight.has(k)) continue;
      c.inflight.add(k);
      api
        .get<{ units?: string[]; containers?: string[] }>(`/api/terminal/complete?target=${encodeURIComponent(o.target)}&kind=${kind}`)
        .then(
          (r) => map.set(o.target, (kind === "units" ? r.units : r.containers) ?? []),
          () => map.set(o.target, []),
        )
        .finally(() => {
          c.inflight.delete(k);
          bump();
        });
    }
  }, [needUnits, needContainers, o.target, c]);

  const entries = dirKey ? (c.dirs.get(dirKey)?.entries ?? null) : null;
  const units = c.units.get(o.target);
  const containers = c.containers.get(o.target);
  const suggestions = React.useMemo<Suggestion[]>(() => {
    if (!o.enabled) return [];
    return suggest(line, cursor, a, { history: o.history, commands: o.probe?.commands ?? null, spec: spec ?? null, entries, containers: containers ?? [], units: units ?? [] });
  }, [o.enabled, line, cursor, a, o.history, o.probe, spec, entries, containers, units]);

  const loading = o.enabled && ((!!dirKey && !entries) || (!!program && KNOWN.has(program) && spec === undefined));
  return { suggestions, loading };
}
