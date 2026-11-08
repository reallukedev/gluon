"use client";
import * as React from "react";
import Link from "next/link";
import { useIntentPrefetch } from "@/lib/client/prefetch";

type Props = React.ComponentPropsWithRef<typeof Link>;
type Handler = ((e: never) => void) | undefined;

/** Calls the caller's handler, then ours. */
function both<E>(theirs: Handler, ours: Handler) {
  if (!theirs) return ours;
  if (!ours) return theirs;
  return (e: E) => {
    (theirs as (e: E) => void)(e);
    (ours as (e: E) => void)(e);
  };
}

/**
 * A Link for places people move between all the time (the sidebar, tabs, section lists, back links):
 * pointing at it, focusing it or pressing it fetches the whole page, so the click lands on real content.
 * Lists of many links keep the plain Link, which only fetches a page's skeleton.
 */
export function IntentLink({ href, onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, ...rest }: Props) {
  const intent = useIntentPrefetch(typeof href === "string" ? href : undefined) as Partial<Record<"onPointerEnter" | "onPointerLeave" | "onPointerDown" | "onFocus" | "onBlur", Handler>>;
  return (
    <Link
      href={href}
      onPointerEnter={both(onPointerEnter as Handler, intent.onPointerEnter)}
      onPointerLeave={both(onPointerLeave as Handler, intent.onPointerLeave)}
      onPointerDown={both(onPointerDown as Handler, intent.onPointerDown)}
      onFocus={both(onFocus as Handler, intent.onFocus)}
      onBlur={both(onBlur as Handler, intent.onBlur)}
      {...rest}
    />
  );
}
