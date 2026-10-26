export interface StatusServerOptions {
  port?: number;
  motd?: string;
  description?: unknown;
  version?: string;
  protocol?: number;
  online?: number;
  max?: number;
  players?: string[];
  legacy?: boolean;
  favicon?: string;
  padding?: number;
  split?: boolean;
}

export function startStatusServer(opts?: StatusServerOptions): Promise<{ port: number; seen: string[]; close: () => Promise<void> }>;
