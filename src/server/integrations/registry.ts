import "server-only";
import type { KindDef } from "./kinds/base";
import { def as jellyfin } from "./kinds/jellyfin";
import { def as immich } from "./kinds/immich";
import { def as subsonic } from "./kinds/subsonic";
import { def as slskd } from "./kinds/slskd";
import { def as homebridge } from "./kinds/homebridge";
import { def as homeassistant } from "./kinds/homeassistant";
import { def as coolify } from "./kinds/coolify";
import { def as genericJson } from "./kinds/generic-json";
import { INTEGRATION_KINDS, type IntegrationKind, type IntegrationKindInfo } from "@/lib/widgets-types";
import { notFound } from "../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDef = KindDef<any>;

export const KINDS: Record<IntegrationKind, AnyDef> = {
  jellyfin,
  immich,
  subsonic,
  slskd,
  homebridge,
  homeassistant,
  coolify,
  "generic-json": genericJson,
};

export function isKind(k: string): k is IntegrationKind {
  return (INTEGRATION_KINDS as readonly string[]).includes(k);
}

export function kindDef(kind: string): AnyDef {
  if (!isKind(kind)) throw notFound("That kind of connection");
  return KINDS[kind];
}

export function kindInfo(def: AnyDef): IntegrationKindInfo {
  return {
    kind: def.kind,
    label: def.label,
    description: def.description,
    baseUrlLabel: def.baseUrlLabel,
    baseUrlPlaceholder: def.baseUrlPlaceholder,
    fields: def.fields,
    keyHelp: def.keyHelp,
    widgets: def.widgets,
  };
}

export const allKindInfo = (): IntegrationKindInfo[] => INTEGRATION_KINDS.map((k) => kindInfo(KINDS[k]));
