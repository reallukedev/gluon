"use client";
import * as React from "react";
import type { ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Empty, Notice, Panel } from "@/components/ui/Surface";
import { hostFailure } from "./hostFailure";
import s from "./system.module.css";

/** The `program` -> one line on what the person can do, for a host that lacks it. */
export interface MissingCopy {
  title: string;
  body: React.ReactNode;
}

/**
 * A host command failed. A missing program is a fact about this machine, not a fault, so it reads
 * as an empty state; a timeout or real failure is a fault Notice with the raw output tucked away.
 */
export function HostError({
  error,
  title,
  missing,
  onRetry,
}: {
  error: ApiError;
  /** "Couldn't …": what failed, for timeouts and other faults. */
  title: string;
  missing: MissingCopy;
  onRetry: () => unknown;
}) {
  const f = hostFailure(error);
  const [checking, setChecking] = React.useState(false);
  const retry = async () => {
    setChecking(true);
    try {
      await onRetry();
    } finally {
      setChecking(false);
    }
  };
  const details = (
    <Disclosure summary="Details">
      <code className={s.errorDetail}>
        {f.command ? `$ ${f.command}\n` : ""}
        {error.message}
      </code>
    </Disclosure>
  );

  if (f.kind === "missing") {
    return (
      <Panel flush className="appear">
        <Empty
          title={missing.title}
          action={
            <Button size="sm" onClick={retry} loading={checking}>
              Check again
            </Button>
          }
        >
          {missing.body}
        </Empty>
      </Panel>
    );
  }
  return (
    <Notice
      tone="fault"
      title={title}
      action={
        <Button size="sm" onClick={retry} loading={checking}>
          Try again
        </Button>
      }
    >
      {f.kind === "timeout" ? "The server took too long to answer. It may be busy; try again in a minute." : "Try again. If it keeps failing, the details show what the server said."}
      {f.kind === "other" && details}
    </Notice>
  );
}
