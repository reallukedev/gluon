"use client";
import Link from "next/link";
import type { RoutesResponse } from "@/lib/network-types";
import { ApiError, useApi } from "@/lib/client/api";
import { Panel, Notice, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { AffixInput, Checkbox, Field, Switch } from "@/components/ui/Field";
import { suggestLabel } from "@/components/network/shared";
import { labelError } from "@/lib/builder/address";
import type { Draft } from "../state";
import type { AddressState } from "./address";
import { FlowNav } from "./FlowFrame";
import s from "../builder.module.css";
import f from "./flow.module.css";

/**
 * Optional: a subdomain of the server's domain that leads to the app's web page. Off by
 * default, because putting something on the internet should be a choice someone makes.
 * The address is added after the app starts, through the Network page's own API.
 */
export function AddressStep({ draft, name, choice: { choice, update }, onBack, onNext }: { draft: Draft; name: string; choice: AddressState; onBack: () => void; onNext: () => void }) {
  const { data, error, isLoading } = useApi<RoutesResponse>("/api/network/routes", { revalidateOnFocus: false });
  const port = draft.spec.web.port ?? draft.spec.web.containerPort;
  const label = choice.label || suggestLabel(name);
  const err = data && choice.on ? labelError(label, data.config) : null;
  const wildcard = data ? Object.values(data.coveredByWildcard).some(Boolean) : false;
  const on = choice.on && !!data;
  const ready = !on || (!err && choice.ack);
  const unavailable = error instanceof ApiError && (error.code === "no_routes" || error.status === 503);

  return (
    <div className={f.stack}>
      <Panel title="Reach it from the internet">
        {isLoading && !data ? (
          <div className={f.skeletonRows}>
            <Skeleton height={34} />
            <Skeleton width="70%" height={14} />
          </div>
        ) : error ? (
          <Notice title={unavailable ? "Public addresses aren't set up on this server" : "Gluon couldn't read the public addresses"}>
            {error.message} You can add an address later on the <Link className={s.link} href="/network">Network</Link> page.
          </Notice>
        ) : data ? (
          <div className={s.stack}>
            <div className={s.inlineControl}>
              <span id="addr-on">
                Give it an address on the internet
                <span className={s.controlHint}>
                  People open it at an address under <span className="mono">{data.config.base_domain}</span>, from anywhere. Caddy passes them to port <span className="mono num">{port}</span> on this server.
                </span>
              </span>
              <Switch checked={on} onChange={(on) => update({ on, label, ack: on ? choice.ack : false })} aria-labelledby="addr-on" />
            </div>
            {on && (
              <div className={`${s.stack} ${f.reveal}`} data-motion-gentle="">
                <Field label="Address" description={wildcard ? `*.${data.config.base_domain} already points here, so it works without a DNS change.` : "Add a DNS record for it if your domain doesn't have a wildcard. The Network page shows how."} error={err}>
                  <AffixInput before="https://" after={`.${data.config.base_domain}`} value={label} mono spellCheck={false} autoCapitalize="off" onChange={(e) => update({ label: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63) })} aria-label="Subdomain" />
                </Field>
                <Notice tone="attention" title={`Anyone with the address can reach ${name}`}>
                  <div className={f.ack}>
                    <p>Gluon can&apos;t tell whether {name} asks for a password. Check that it does before you share the address.</p>
                    <Checkbox checked={choice.ack} onChange={(ack) => update({ ack })}>
                      {name} has its own sign-in, or anyone may use it
                    </Checkbox>
                  </div>
                </Notice>
              </div>
            )}
          </div>
        ) : null}
      </Panel>
      <FlowNav back={{ label: "Back", onClick: onBack }}>
        <Button
          variant="primary"
          disabled={!ready || (isLoading && !data)}
          onClick={() => {
            // Without the routes there's no address to add, whatever was chosen before.
            if (!on && choice.on) update({ on: false });
            onNext();
          }}
        >
          {on ? "Continue with the address" : "Continue without one"}
        </Button>
      </FlowNav>
    </div>
  );
}
