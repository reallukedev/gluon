"use client";
import * as React from "react";

/**
 * A value the form edits locally and writes to the compose file as you type. The file's copy is
 * adopted again only when it changes for some other reason (another field, the Compose tab), so
 * the writer's normalising (trimming, "0.50" → 0.5) never fights the cursor.
 */
export function useDocState<T>(fromDoc: T, write: (v: T) => void, normalize: (v: T) => T = (v) => v) {
  const [value, setValue] = React.useState<T>(fromDoc);
  const key = JSON.stringify(fromDoc);
  const written = React.useRef(key);
  React.useEffect(() => {
    if (key !== written.current) {
      written.current = key;
      setValue(JSON.parse(key) as T);
    }
  }, [key]);
  const update = (next: T) => {
    setValue(next);
    const k = JSON.stringify(normalize(next));
    if (k !== written.current) {
      written.current = k;
      write(next);
    }
  };
  return [value, update] as const;
}

/**
 * Rows (ports, folders, variables) the form edits locally and writes once each is complete, so
 * a half-typed port doesn't turn into nonsense in the file, or vanish while you type.
 */
export function useRows<T>(fromDoc: T[], complete: (r: T) => boolean, normalize: (r: T) => T, write: (rows: T[]) => void) {
  const [rows, setRows] = React.useState<T[]>(fromDoc);
  const key = JSON.stringify(fromDoc);
  const written = React.useRef(key);
  React.useEffect(() => {
    if (key !== written.current) {
      written.current = key;
      setRows(JSON.parse(key) as T[]);
    }
  }, [key]);
  const update = (next: T[]) => {
    setRows(next);
    const done = next.filter(complete);
    const k = JSON.stringify(done.map(normalize));
    if (k !== written.current) {
      written.current = k;
      write(done);
    }
  };
  return [rows, update] as const;
}

/**
 * Where each local row sits among the rows written to the file (null when it isn't written yet),
 * so a check about the file's third port lands on the third complete row, not the third typed one.
 */
export function writtenIndex<T>(rows: T[], complete: (r: T) => boolean): (number | null)[] {
  let n = 0;
  return rows.map((r) => (complete(r) ? n++ : null));
}
