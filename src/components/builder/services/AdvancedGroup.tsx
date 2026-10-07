"use client";
import * as React from "react";
import { Plus, Xmark } from "iconoir-react";
import type { BuilderTarget, Issue } from "@/lib/builder-types";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input, Switch, Checkbox } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Disclosure } from "@/components/ui/Disclosure";
import { setCommand, setCpus, setDependsOn, setDevices, setGpu, setHealth, setHostNetwork, setMemory, setPrivileged, setRestart, setUser, type HealthForm, type ServiceForm } from "@/lib/builder/compose";
import { DEVICE_RE, cpusError, durationError, memoryError } from "@/lib/builder/names";
import { FieldNotes, errorAt, issuesAt } from "../Issues";
import type { Draft } from "../state";
import { LabelsField } from "./LabelsField";
import { NetworksField } from "./NetworksField";
import { useDocState, useRows } from "./useRows";
import s from "../builder.module.css";

const RESTART = [
  { value: "unless-stopped", label: "Unless stopped", description: "Comes back after crashes and reboots" },
  { value: "always", label: "Always" },
  { value: "on-failure", label: "On failure", description: "Only when it crashes" },
  { value: "no", label: "Never" },
];

const NO_HEALTH: HealthForm = { test: "", interval: "", timeout: "", retries: "", startPeriod: "" };
/** What setHealth leaves in the file, so typing a trailing space doesn't get undone. */
const normalHealth = (h: HealthForm): HealthForm => {
  const t = { test: h.test.trim(), interval: h.interval.trim(), timeout: h.timeout.trim(), retries: /^\d+$/.test(h.retries.trim()) ? h.retries.trim() : "", startPeriod: h.startPeriod.trim() };
  return t.test || t.interval || t.timeout || t.retries || t.startPeriod ? t : NO_HEALTH;
};

/** Everything a service rarely needs, behind one disclosure that opens itself when something in it is wrong. */
export function AdvancedGroup({ draft, form: f, names, issues, target }: { draft: Draft; form: ServiceForm; names: string[]; issues: Issue[]; target: BuilderTarget }) {
  const edit = draft.editCompose;
  const base = `services.${f.name}`;
  const [memory, setMemoryLocal] = useDocState(f.memory, (v) => edit((doc) => setMemory(doc, f.name, v)), (v) => v.trim().toLowerCase().replace(/\s+/g, ""));
  const [cpus, setCpusLocal] = useDocState(f.cpus, (v) => edit((doc) => setCpus(doc, f.name, v)), (v) => (/^\d+(\.\d+)?$/.test(v.trim()) ? String(Number(v.trim())) : v.trim()));
  const [health, setHealthLocal] = useDocState<HealthForm>(f.health ?? NO_HEALTH, (h) => edit((doc) => setHealth(doc, f.name, h)), normalHealth);
  const [devices, setDevicesLocal] = useRows<string>(f.devices, (d) => DEVICE_RE.test(d), (d) => d, (done) => edit((doc) => setDevices(doc, f.name, done)));
  const others = names.filter((n) => n !== f.name);
  const set = [f.command, f.user, f.memory, f.cpus, f.gpu, f.devices.length, f.hostNetwork, f.health, f.dependsOn.length, f.privileged, f.labels.length, f.networks.length].filter(Boolean).length;
  const mine = [
    ...issuesAt(issues, `${base}.advanced`),
    ...["memory", "cpus", "gpu", "dependsOn", "networks", "health.interval", "health.timeout", "health.start_period", "health.retries"].flatMap((k) => issuesAt(issues, `${base}.${k}`)),
    ...issuesAt(issues, `${base}.devices`, true),
    ...issuesAt(issues, `${base}.labels`, true),
  ];
  const [open, setOpen] = React.useState(mine.some((i) => i.level === "error"));
  const hasDri = devices.some((d) => d.startsWith("/dev/dri"));

  return (
    <section className={s.group} data-field={`${base}.advanced`}>
      <Disclosure summary="More settings" meta={set ? `${set} set` : undefined} open={open} onOpenChange={setOpen}>
        <div className={s.advancedBody}>
          <div className={s.subGroup}>
            <h4 className={s.subTitle}>Resources</h4>
            <div className={s.threeCol}>
              <div data-field={`${base}.memory`}>
                <Field label="Memory limit" optional description="Like 512m or 2g." error={memory ? memoryError(memory) : null}>
                  <Input value={memory} mono onChange={(e) => setMemoryLocal(e.target.value)} placeholder="No limit" />
                </Field>
              </div>
              <div data-field={`${base}.cpus`}>
                <Field label="CPU limit" optional description="In cores, like 0.5 or 2." error={cpus ? cpusError(cpus) : null}>
                  <Input value={cpus} mono inputMode="decimal" onChange={(e) => setCpusLocal(e.target.value)} placeholder="No limit" />
                </Field>
              </div>
            </div>
            <div className={s.inlineControl} data-field={`${base}.gpu`}>
              <span id={`gpu-${f.name}`}>
                Use the NVIDIA graphics card
                <span className={s.controlHint}>For video transcoding or AI models. The server needs the NVIDIA Container Toolkit.</span>
              </span>
              <Switch checked={f.gpu} onChange={(on) => edit((doc) => setGpu(doc, f.name, on))} aria-labelledby={`gpu-${f.name}`} />
            </div>
          </div>

          <div className={s.subGroup}>
            <h4 className={s.subTitle}>Starting</h4>
            <div className={s.twoCol}>
              <Field label="Restart">
                <Select className={s.fill} value={f.restart || "no"} onChange={(v) => edit((doc) => setRestart(doc, f.name, v))} options={RESTART} />
              </Field>
              <div data-field={`${base}.dependsOn`}>
                <Field label="Starts after" optional>
                  {others.length ? (
                    <div className={s.checkList}>
                      {others.map((n) => (
                        <Checkbox key={n} checked={f.dependsOn.includes(n)} onChange={(on) => edit((doc) => setDependsOn(doc, f.name, on ? [...f.dependsOn, n] : f.dependsOn.filter((d) => d !== n)))}>
                          <span className="mono">{n}</span>
                        </Checkbox>
                      ))}
                    </div>
                  ) : (
                    <p className={s.hint}>It&apos;s the only service.</p>
                  )}
                </Field>
              </div>
              <div className={s.wide}>
                <Field label="Command" optional description="Replaces the image's own command. Quote arguments with spaces.">
                  <Input value={f.command} mono onChange={(e) => edit((doc) => setCommand(doc, f.name, e.target.value))} placeholder="The image's default" spellCheck={false} />
                </Field>
              </div>
              <Field label="Run as user" optional description="uid:gid, like 1000:1000.">
                <Input value={f.user} mono onChange={(e) => edit((doc) => setUser(doc, f.name, e.target.value))} placeholder="The image's default" />
              </Field>
            </div>
          </div>

          <div className={s.subGroup}>
            <h4 className={s.subTitle}>Network</h4>
            <div className={s.inlineControl}>
              <span id={`hn-${f.name}`}>
                Use the server&apos;s network
                <span className={s.controlHint}>For apps that discover devices on your network (DLNA, HomeKit). Its ports open straight on the server.</span>
              </span>
              <Switch checked={f.hostNetwork} onChange={(on) => edit((doc) => setHostNetwork(doc, f.name, on))} aria-labelledby={`hn-${f.name}`} />
            </div>
            <NetworksField draft={draft} form={f} issues={issues} target={target} />
          </div>

          <div className={s.subGroup} data-field={`${base}.devices`}>
            <h4 className={s.subTitle}>Devices</h4>
            {devices.map((d, i) => (
              <div key={i} className={`${s.row} ${s.devRow}`}>
                <Input value={d} mono aria-label="Device" placeholder="/dev/dri" onChange={(e) => setDevicesLocal(devices.map((x, j) => (j === i ? e.target.value : x)))} aria-invalid={(!!d && !DEVICE_RE.test(d)) || undefined} />
                <IconButton label="Remove this device" onClick={() => setDevicesLocal(devices.filter((_, j) => j !== i))}>
                  <Xmark />
                </IconButton>
              </div>
            ))}
            {!hasDri && (
              <p className={s.hint}>
                Intel and AMD graphics are shared as /dev/dri.{" "}
                <button type="button" className={s.link} onClick={() => setDevicesLocal([...devices, "/dev/dri:/dev/dri"])}>
                  Add /dev/dri
                </button>
              </p>
            )}
            <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setDevicesLocal([...devices, ""])}>
              Add a device
            </Button>
          </div>

          <div className={s.subGroup} data-field={`${base}.health`}>
            <h4 className={s.subTitle}>Health check</h4>
            {f.healthDisabled ? (
              <p className={s.hint}>
                Turned off for this service.{" "}
                <button type="button" className={s.link} onClick={() => edit((doc) => setHealth(doc, f.name, null))}>
                  Use the image&apos;s own
                </button>
              </p>
            ) : (
              <div className={s.healthGrid}>
                <div className={s.wide}>
                  <Field label="Command" optional description="Runs inside the container; exit code 0 means healthy. Leave it empty to keep the image's own check.">
                    <Input value={health.test} mono placeholder="curl -fs http://localhost:8080/health || exit 1" onChange={(e) => setHealthLocal({ ...health, test: e.target.value })} spellCheck={false} />
                  </Field>
                </div>
                <Field label="Every" optional error={errorAt(issues, `${base}.health.interval`) ?? durationError(health.interval)}>
                  <Input value={health.interval} mono placeholder="30s" onChange={(e) => setHealthLocal({ ...health, interval: e.target.value })} />
                </Field>
                <Field label="Gives up after" optional error={errorAt(issues, `${base}.health.timeout`) ?? durationError(health.timeout)}>
                  <Input value={health.timeout} mono placeholder="30s" onChange={(e) => setHealthLocal({ ...health, timeout: e.target.value })} />
                </Field>
                <Field label="Tries before unhealthy" optional error={errorAt(issues, `${base}.health.retries`)}>
                  <Input value={health.retries} inputMode="numeric" mono placeholder="3" onChange={(e) => setHealthLocal({ ...health, retries: e.target.value.replace(/\D/g, "") })} />
                </Field>
                <Field label="Grace period at start" optional description="Failures don't count yet." error={errorAt(issues, `${base}.health.start_period`) ?? durationError(health.startPeriod)}>
                  <Input value={health.startPeriod} mono placeholder="0s" onChange={(e) => setHealthLocal({ ...health, startPeriod: e.target.value })} />
                </Field>
              </div>
            )}
          </div>

          <LabelsField draft={draft} form={f} issues={issues} />

          <div className={s.inlineControl}>
            <span id={`pv-${f.name}`}>
              Privileged
              <span className={s.controlHint}>Full access to this server&apos;s hardware and kernel. Only for apps that truly need it.</span>
            </span>
            <Switch checked={f.privileged} onChange={(on) => edit((doc) => setPrivileged(doc, f.name, on))} aria-labelledby={`pv-${f.name}`} />
          </div>
          {f.extraKeys.length > 0 && (
            <p className={s.extra}>
              Also set in Compose: <span className="mono">{f.extraKeys.join(", ")}</span>.
            </p>
          )}
          <FieldNotes issues={mine.filter((i) => !i.field?.includes(".health.") && i.field !== `${base}.networks`)} errors />
        </div>
      </Disclosure>
    </section>
  );
}
