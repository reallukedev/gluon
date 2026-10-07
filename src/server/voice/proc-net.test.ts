import { describe, expect, it } from "vitest";
import { countEstablished } from "./proc-net";

const TABLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:FCE2 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10000        0 1
   1: 020013AC:FCE2 010013AC:AE68 01 00000000:00000000 02:000AE79D 00000000 10000        0 2
  sl  local_address                         remote_address                        st
   0: 0000000000000000FFFF0000020013AC:FCE2 0000000000000000FFFF0000010013AC:C8EA 01 00000000:00000000
   1: 0000000000000000FFFF0000020013AC:FCE2 0000000000000000FFFF0000010013AC:C8CC 06 00000000:00000000
   2: 0000000000000000FFFF0000020013AC:1966 0000000000000000FFFF0000010013AC:C8CD 01 00000000:00000000
`;

describe("countEstablished", () => {
  it("counts established connections to the voice port only, IPv4 and IPv6", () => {
    // Listening (0A) and closing (06) sockets and other ports (6502 = 1966) don't count.
    expect(countEstablished(TABLE, 64738)).toBe(2);
    expect(countEstablished(TABLE, 6502)).toBe(1);
    expect(countEstablished("", 64738)).toBe(0);
  });
});
