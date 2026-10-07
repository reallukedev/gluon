// xmpp.js ships no types. Only what xmpp.ts uses, loosely.

declare module "@xmpp/xml" {
  export interface Element {
    name: string;
    attrs: Record<string, string>;
    children: (Element | string)[];
    is(name: string, ns?: string): boolean;
    getChild(name: string, ns?: string): Element | undefined;
    getChildren(name: string, ns?: string): Element[];
    getChildText(name: string, ns?: string): string | null;
    getNS(): string;
    text(): string;
    toString(): string;
  }
  export default function xml(name: string, attrs?: Record<string, string | undefined> | null, ...children: (Element | string | null | undefined | false)[]): Element;
}

declare module "@xmpp/client-core" {
  import type { Element } from "@xmpp/xml";
  import type { EventEmitter } from "node:events";
  export class Client extends EventEmitter {
    constructor(options: { service: string; domain: string; timeout?: number; lang?: string });
    jid: { toString(): string } | null;
    socket: (EventEmitter & { secure?: boolean; end(): void; destroy?: () => void }) | null;
    status: string;
    transports: unknown[];
    options: { domain: string };
    isSecure(): boolean;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    send(el: Element): Promise<void>;
    sendReceive(el: Element, timeout?: number): Promise<Element>;
    restart(): Promise<unknown>;
    _attachSocket(socket: unknown): void;
    _detachSocket(): void;
  }
  export { default as xml } from "@xmpp/xml";
  export function jid(local: string, domain?: string): { toString(): string };
}

declare module "@xmpp/middleware" {
  export default function middleware(o: { entity: unknown }): { use(fn: (ctx: unknown, next: () => Promise<unknown>) => unknown): unknown };
}

declare module "@xmpp/stream-features" {
  import type { Element } from "@xmpp/xml";
  type Ctx = { entity: import("@xmpp/client-core").Client; stanza: Element };
  export default function streamFeatures(o: { middleware: unknown }): {
    use(name: string, ns: string, handler: (ctx: Ctx, next: () => Promise<unknown>, feature: Element) => unknown): unknown;
  };
}

declare module "@xmpp/iq/caller.js" {
  export default function iqCaller(o: { middleware: unknown; entity: unknown }): unknown;
}

declare module "@xmpp/sasl" {
  export default function sasl(o: { streamFeatures: unknown; saslFactory: unknown }, onAuthenticate: (done: (creds: { username: string; password: string }, mechanism: string) => Promise<void>, mechanisms: string[]) => Promise<void>): unknown;
}

declare module "@xmpp/sasl-scram-sha-1" {
  export default function scram(factory: unknown): unknown;
}
declare module "@xmpp/sasl-plain" {
  export default function plain(factory: unknown): unknown;
}

declare module "@xmpp/resource-binding" {
  export default function resourceBinding(o: { iqCaller: unknown; streamFeatures: unknown }, resource?: string): unknown;
}

declare module "@xmpp/tcp" {
  export default function tcp(o: { entity: unknown }): unknown;
}

declare module "@xmpp/tls/lib/Socket.js" {
  import type { EventEmitter } from "node:events";
  import type { ConnectionOptions, TLSSocket } from "node:tls";
  export default class Socket extends EventEmitter {
    secure: boolean;
    socket: TLSSocket | null;
    connect(options: ConnectionOptions): void;
    end(): void;
    write(data: string, fn?: (err?: Error) => void): void;
  }
}

declare module "@xmpp/events" {
  export function promise<T = unknown>(target: unknown, event: string, rejectEvent?: string | null, timeout?: number): Promise<T>;
}

declare module "saslmechanisms" {
  export default class SASLFactory {
    use(mech: unknown): this;
  }
}
