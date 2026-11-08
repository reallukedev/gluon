"use client";
import * as React from "react";

/**
 * The file's copy is adopted again only when it changes for another reason, so the writer's normalising never fights
 * the cursor.
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

/** Written once each row is complete, so a half-typed port doesn't turn into nonsense in the file. */
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

/** Null when not written yet, so a check about the file's third port lands on the third complete row. */
export function writtenIndex<T>(rows: T[], complete: (r: T) => boolean): (number | null)[] {
  let n = 0;
  return rows.map((r) => (complete(r) ? n++ : null));
}
