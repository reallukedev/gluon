"use client";
import * as React from "react";

export interface AddressChoice {
  on: boolean;
  label: string;
  ack: boolean;
  saved: { host: string } | null;
}

const EMPTY: AddressChoice = { on: false, label: "", ack: false, saved: null };
const key = (id: string) => `gluon.newApp.address.${id}`;

function read(id: string): AddressChoice {
  try {
    const raw = window.sessionStorage.getItem(key(id));
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<AddressChoice>;
    return { on: v.on === true, label: typeof v.label === "string" ? v.label.slice(0, 63) : "", ack: v.ack === true, saved: v.saved && typeof v.saved.host === "string" ? { host: v.saved.host } : null };
  } catch {
    return EMPTY;
  }
}

/** Kept in this tab (it isn't part of the app's files), so a reload mid-flow keeps it. */
export function useAddressChoice(id: string) {
  const [choice, setChoice] = React.useState<AddressChoice>(EMPTY);
  React.useEffect(() => setChoice(read(id)), [id]);
  const update = React.useCallback(
    (patch: Partial<AddressChoice>) =>
      setChoice((c) => {
        const next = { ...c, ...patch };
        try {
          window.sessionStorage.setItem(key(id), JSON.stringify(next));
        } catch {
          /* private mode: the choice lasts until the page closes */
        }
        return next;
      }),
    [id],
  );
  return { choice, update };
}

export type AddressState = ReturnType<typeof useAddressChoice>;
