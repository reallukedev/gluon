"use client";
import * as React from "react";

export interface AddressChoice {
  /** Publish the web page on the internet. Off until the person turns it on. */
  on: boolean;
  label: string;
  /** They read that anyone with the address reaches the app. */
  ack: boolean;
  /** Set once the address is saved, so a reload doesn't add it twice. */
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

/**
 * The public address choice lives in this tab until the app runs (it isn't part of the app's
 * files), so a reload in the middle of the flow keeps it.
 */
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
