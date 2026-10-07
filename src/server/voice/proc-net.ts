/** Established connections whose local port is `port`, from /proc/net/tcp text. Pure. */
export function countEstablished(procNetTcp: string, port: number): number {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  let n = 0;
  for (const line of procNetTcp.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] === "sl") continue;
    if (cols[1]?.split(":").pop()?.toUpperCase() === hex && cols[3] === "01") n++;
  }
  return n;
}
