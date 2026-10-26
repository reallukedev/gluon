import "server-only";
import Docker from "dockerode";

type G = typeof globalThis & { __gluonDocker?: Docker };
const g = globalThis as G;

export function docker(): Docker {
  g.__gluonDocker ??= new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
  return g.__gluonDocker;
}
