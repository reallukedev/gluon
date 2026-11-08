import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  aptUnattended,
  containerRisks,
  dockerTcpHosts,
  emptyPasswords,
  globalV6,
  groupMembers,
  igdControlUrl,
  iptablesInput,
  nftInput,
  nopasswdRules,
  osRelease,
  parseAuthorizedKeys,
  parseFail2banJail,
  parseGroup,
  parseMappingEntry,
  parsePasswd,
  parseSshdT,
  parseSsListen,
  parseUfw,
  riskyListeners,
  ssdpLocation,
  SYSCTL_RULES,
  weakKey,
  weakSshAlgorithms,
} from "./hardening-parse";

/** An ssh-rsa public key line for a fresh key of `bits`, in the same wire format OpenSSH writes. */
function rsaLine(bits: number, comment: string): string {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const mpint = (b64url: string) => {
    let b = Buffer.from(b64url, "base64url");
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return b;
  };
  const field = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const blob = Buffer.concat([field(Buffer.from("ssh-rsa")), field(mpint(jwk.e)), field(mpint(jwk.n))]);
  return `ssh-rsa ${blob.toString("base64")} ${comment}`;
}

describe("listening sockets", () => {
  const ss = [
    'tcp   LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=812,fd=3))',
    'tcp   LISTEN 0      4096            [::]:22            [::]:*    users:(("sshd",pid=812,fd=4))',
    'tcp   LISTEN 0      4096       127.0.0.1:2375       0.0.0.0:*    users:(("dockerd",pid=900,fd=9))',
    'tcp   LISTEN 0      5      192.168.1.20:23         0.0.0.0:*    users:(("inetd",pid=77,fd=5))',
    'tcp   LISTEN 0      5               *:5901               *:*    users:(("Xvnc",pid=1200,fd=6))',
    'udp   UNCONN 0      0     127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=13))',
    'udp   UNCONN 0      0         0.0.0.0:161        0.0.0.0:*    users:(("snmpd",pid=1300,fd=8))',
    "garbage line",
  ].join("\n");

  it("reads protocol, address, port and program, dropping brackets and interface suffixes", () => {
    const l = parseSsListen(ss);
    expect(l).toHaveLength(7);
    expect(l[1]).toEqual({ proto: "tcp", addr: "::", port: 22, process: "sshd" });
    expect(l[5]).toEqual({ proto: "udp", addr: "127.0.0.53", port: 53, process: "systemd-resolve" });
  });

  it("flags plain-text and remote-screen services that answer the network, worst first, ignoring loopback", () => {
    const r = riskyListeners(parseSsListen(ss));
    expect(r.map((x) => `${x.label}:${x.port}`)).toEqual(["Telnet:23", "SNMP:161", "VNC remote screen:5901"]);
    expect(r[0]!.severity).toBe("fail");
    // Docker's API on loopback isn't a network risk.
    expect(r.some((x) => x.port === 2375)).toBe(false);
  });
});

describe("firewall", () => {
  const ufwNft = `table ip filter {
	chain INPUT {
		type filter hook input priority filter; policy drop;
		counter packets 10 bytes 600 jump ufw-before-logging-input
		counter packets 10 bytes 600 jump ufw-before-input
	}
	chain FORWARD {
		type filter hook forward priority filter; policy drop;
	}
	chain ufw-before-input {
		iifname "lo" counter accept
		ct state related,established counter accept
	}
}
table ip6 filter {
	chain INPUT {
		type filter hook input priority filter; policy accept;
	}
}`;
  const dockerOnly = `table ip nat {
	chain DOCKER {
		iifname "docker0" counter return
	}
}
table ip filter {
	chain INPUT {
		type filter hook input priority filter; policy accept;
	}
	chain DOCKER-USER {
		counter return
	}
}`;
  const inetRules = `table inet firewall {
	set allowed { type ipv4_addr; elements = { 192.168.1.2,
		192.168.1.3 } }
	chain inbound {
		type filter hook input priority 0; policy accept;
		tcp dport { 22, 443 } accept
		ip saddr @allowed accept
		counter reject with icmpx type admin-prohibited
	}
}`;

  it("sees ufw's default-drop input chain for IPv4 and the open IPv6 one", () => {
    expect(nftInput(ufwNft, ["ip", "inet"])).toMatchObject({ filtering: true });
    expect(nftInput(ufwNft, ["ip6", "inet"])).toMatchObject({ filtering: false });
  });

  it("doesn't mistake Docker's own chains for a firewall", () => {
    expect(nftInput(dockerOnly, ["ip", "inet"])).toMatchObject({ filtering: false });
  });

  it("counts a reject rule in an inet table for both families, across multi-line sets", () => {
    expect(nftInput(inetRules, ["ip", "inet"])?.filtering).toBe(true);
    expect(nftInput(inetRules, ["ip6", "inet"])?.filtering).toBe(true);
  });

  it("returns null when no table covers the family, so iptables gets asked instead", () => {
    expect(nftInput(dockerOnly, ["ip6"])).toBeNull();
    expect(nftInput("", ["ip"])).toBeNull();
  });

  it("reads iptables INPUT policy and filtering jumps", () => {
    expect(iptablesInput("-P INPUT DROP\n-A INPUT -i lo -j ACCEPT")?.filtering).toBe(true);
    expect(iptablesInput("-P INPUT ACCEPT\n-A INPUT -j f2b-sshd")?.filtering).toBe(true);
    expect(iptablesInput("-P INPUT ACCEPT\n-A INPUT -i lo -j ACCEPT")?.filtering).toBe(false);
    expect(iptablesInput("")).toBeNull();
  });

  it("reads ufw's status and incoming default", () => {
    expect(parseUfw("Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), deny (routed)\n")).toEqual({ active: true, incoming: "deny" });
    expect(parseUfw("Status: inactive\n")).toEqual({ active: false, incoming: null });
    expect(parseUfw("ERROR: You need to be root")).toBeNull();
  });
});

it("keeps public IPv6 addresses only (no ULA, link-local or deprecated)", () => {
  const out = [
    "2: eth0    inet6 2001:db8:4d02:aa00::25/128 scope global dynamic noprefixroute \\       valid_lft 85000sec preferred_lft 85000sec",
    "2: eth0    inet6 fd00:1:2:3::25/64 scope global noprefixroute \\       valid_lft forever preferred_lft forever",
    "2: eth0    inet6 2001:db8:4d02:aa00:1:2:3:4/64 scope global deprecated dynamic \\       valid_lft 100sec preferred_lft 0sec",
  ].join("\n");
  expect(globalV6(out)).toEqual(["2001:db8:4d02:aa00::25"]);
});

describe("SSH", () => {
  it("finds retired algorithms in the effective config without flagging OpenSSH's defaults", () => {
    const modern = parseSshdT(
      "ciphers chacha20-poly1305@openssh.com,aes128-ctr,aes256-gcm@openssh.com\nmacs umac-64-etm@openssh.com,hmac-sha2-256-etm@openssh.com,hmac-sha1-etm@openssh.com,umac-64@openssh.com,hmac-sha1\nkexalgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,diffie-hellman-group14-sha256\nhostkeyalgorithms ssh-ed25519,rsa-sha2-512",
    );
    expect(weakSshAlgorithms(modern)).toEqual([]);
    const old = parseSshdT("ciphers aes128-ctr,aes256-cbc,3des-cbc\nmacs hmac-md5,hmac-sha2-256\nkexalgorithms curve25519-sha256,diffie-hellman-group1-sha1,diffie-hellman-group14-sha1\nhostkeyalgorithms ssh-ed25519,ssh-dss");
    expect(weakSshAlgorithms(old)).toEqual([
      { setting: "ciphers", names: ["aes256-cbc", "3des-cbc"] },
      { setting: "macs", names: ["hmac-md5"] },
      { setting: "kexalgorithms", names: ["diffie-hellman-group1-sha1", "diffie-hellman-group14-sha1"] },
      { setting: "hostkeyalgorithms", names: ["ssh-dss"] },
    ]);
  });

  it("keeps every value of repeated sshd -T keys", () => {
    expect(parseSshdT("port 22\nport 2222\nlistenaddress 0.0.0.0:22").get("port")).toEqual(["22", "2222"]);
  });

  it("reads keys behind quoted options, measures RSA size from the blob, and flags only weak ones", () => {
    const text = [
      "# laptop",
      rsaLine(1024, "old@laptop"),
      `from="192.168.1.0/24,10.0.0.1",command="/usr/bin/backup --flag x" ${rsaLine(3072, "backup@nas")}`,
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl phone",
      "ssh-dss AAAAB3NzaC1kc3MAAACBAP1/U4EddRIpUt9KnC7s5Of2EbdSPO9EAMMeP4C2USZpRV1AIlH7WT2NWPq ancient",
      "not a key at all",
    ].join("\n");
    const keys = parseAuthorizedKeys(text);
    expect(keys.map((k) => [k.type, k.bits, k.comment, k.restricted])).toEqual([
      ["ssh-rsa", 1024, "old@laptop", false],
      ["ssh-rsa", 3072, "backup@nas", true],
      ["ssh-ed25519", null, "phone", false],
      ["ssh-dss", null, "ancient", false],
    ]);
    expect(keys.map(weakKey)).toEqual(["RSA with only 1024 bits", null, null, "DSA, which OpenSSH no longer trusts"]);
  });

  it("reads fail2ban's jail counters", () => {
    expect(parseFail2banJail("Status for the jail: sshd\n|- Filter\n|  |- Currently failed:\t2\n`- Actions\n   |- Currently banned:\t3\n   |- Total banned:\t41\n")).toEqual({ banned: 3, total: 41 });
    expect(parseFail2banJail("Sorry but the jail 'sshd' does not exist")).toEqual({ banned: null, total: null });
  });
});

describe("host accounts", () => {
  const passwd = parsePasswd(
    [
      "root:x:0:0:root:/root:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      "toor:x:0:0::/root:/bin/sh",
      "alex:x:1000:1000:Alex,,,:/home/alex:/bin/bash",
      "guest::1001:1001::/home/guest:/bin/bash",
      "svc:x:1002:1002::/srv:/usr/sbin/nologin",
      "pi:x:1003:27::/home/pi:/bin/bash",
      "+@nis::::::",
    ].join("\n"),
  );

  it("parses entries and skips NIS lines", () => {
    expect(passwd.map((p) => p.name)).toEqual(["root", "daemon", "toor", "alex", "guest", "svc", "pi"]);
  });

  it("finds login accounts with no password in passwd or shadow, ignoring locked and service accounts", () => {
    const shadow = ["root:!:19000:0:99999:7:::", "alex:$y$j9T$abc$def:19000:0:99999:7:::", "svc::19000::::::", "pi::19000::::::", "guest:*:19000::::::"].join("\n");
    expect(emptyPasswords(shadow, passwd).sort()).toEqual(["guest", "pi"]);
  });

  it("lists group members including users whose primary group it is", () => {
    const groups = parseGroup("sudo:x:27:alex\ndocker:x:998:alex,pi\nwheel:x:10:");
    expect(groupMembers("sudo", groups, passwd).sort()).toEqual(["alex", "pi"]);
    expect(groupMembers("wheel", groups, passwd)).toEqual([]);
    expect(groupMembers("nope", groups, passwd)).toEqual([]);
  });

  it("finds NOPASSWD rules, skipping comments, Defaults and aliases, joining continued lines", () => {
    const sudoers = [
      "Defaults env_reset",
      "Defaults:%sudo !NOPASSWD_NOT_A_RULE",
      "# pi ALL=(ALL) NOPASSWD: ALL",
      "Cmnd_Alias BACKUP = /usr/bin/rsync, NOPASSWD: /bin/true",
      "root ALL=(ALL:ALL) ALL",
      "%sudo ALL=(ALL:ALL) ALL",
      "pi ALL=(ALL) NOPASSWD: ALL",
      "%admins ALL=(ALL) \\",
      "  NOPASSWD: /usr/bin/systemctl",
      "@includedir /etc/sudoers.d",
    ].join("\n");
    expect(nopasswdRules(sudoers)).toEqual(["pi", "%admins"]);
  });
});

it("reads unattended-upgrades in apt's file order, with later files winning and comments ignored", () => {
  expect(aptUnattended([{ name: "20auto-upgrades", text: 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' }])).toBe(true);
  expect(aptUnattended([{ name: "99off", text: 'APT::Periodic::Unattended-Upgrade "0";' }, { name: "20auto-upgrades", text: 'APT::Periodic::Unattended-Upgrade "1";' }])).toBe(false);
  expect(aptUnattended([{ name: "20auto-upgrades", text: '// APT::Periodic::Unattended-Upgrade "1";\n/* APT::Periodic::Unattended-Upgrade "1"; */' }])).toBeNull();
});

it("flags weak kernel values only where the safe default is clear", () => {
  const rule = (k: string) => SYSCTL_RULES.find((r) => r.key === k)!;
  expect(rule("kernel/randomize_va_space").weak("2")).toBeNull();
  expect(rule("kernel/randomize_va_space").weak("0")).toBe("off");
  expect(rule("net/ipv4/tcp_syncookies").weak("1")).toBeNull();
  expect(rule("net/ipv4/tcp_syncookies").weak("2")).toBeNull();
  expect(rule("net/ipv4/conf/all/accept_source_route").weak("1")).toBe("accepted");
});

describe("UPnP", () => {
  it("reads LOCATION from an SSDP reply in any header case", () => {
    expect(ssdpLocation("HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nLocation: http://192.168.1.1:5000/rootDesc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n")).toBe("http://192.168.1.1:5000/rootDesc.xml");
    expect(ssdpLocation("HTTP/1.1 200 OK\r\n\r\n")).toBeNull();
  });

  it("finds the WAN connection service in a nested device description and resolves its control URL", () => {
    const xml = `<?xml version="1.0"?><root><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
      <serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/ctl/L3F</controlURL></service></serviceList>
      <deviceList><device><deviceList><device><serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>/ctl/IPConn</controlURL></service>
      </serviceList></device></deviceList></device></deviceList></device></root>`;
    expect(igdControlUrl(xml, "http://192.168.1.1:5000/rootDesc.xml")).toEqual({ url: "http://192.168.1.1:5000/ctl/IPConn", serviceType: "urn:schemas-upnp-org:service:WANIPConnection:2" });
    expect(igdControlUrl("<root><URLBase>http://10.0.0.1:1900/</URLBase><service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>upnp/control/ppp</controlURL></service></root>", "http://10.0.0.1:80/x.xml")?.url).toBe("http://10.0.0.1:1900/upnp/control/ppp");
    expect(igdControlUrl("<root></root>", "http://10.0.0.1/")).toBeNull();
  });

  it("reads a port mapping and treats a SOAP fault as the end of the table", () => {
    const entry = `<s:Envelope><s:Body><u:GetGenericPortMappingEntryResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
      <NewRemoteHost></NewRemoteHost><NewExternalPort>32400</NewExternalPort><NewProtocol>tcp</NewProtocol><NewInternalPort>32400</NewInternalPort>
      <NewInternalClient>192.168.1.20</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>Plex Media Server &amp; more</NewPortMappingDescription><NewLeaseDuration>7200</NewLeaseDuration>
      </u:GetGenericPortMappingEntryResponse></s:Body></s:Envelope>`;
    expect(parseMappingEntry(entry)).toEqual({ externalPort: 32400, protocol: "TCP", internalClient: "192.168.1.20", internalPort: 32400, description: "Plex Media Server & more", enabled: true, leaseSeconds: 7200 });
    expect(parseMappingEntry('<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode><detail><UPnPError><errorCode>713</errorCode><errorDescription>SpecifiedArrayIndexInvalid</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>')).toBeNull();
  });
});

describe("containers", () => {
  it("collects privilege, the Docker socket, sensitive host folders and switched-off isolation", () => {
    const r = containerRisks({
      HostConfig: { Privileged: false, NetworkMode: "host", PidMode: "host", CapAdd: ["NET_ADMIN", "CAP_SYS_ADMIN", "CHOWN"], SecurityOpt: ["apparmor:unconfined", "no-new-privileges:true"] },
      Mounts: [
        { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: false },
        { Type: "bind", Source: "/", Destination: "/host", RW: false },
        { Type: "bind", Source: "/etc/", Destination: "/etc", RW: true },
        { Type: "bind", Source: "/srv/media", Destination: "/media", RW: true },
        { Type: "volume", Source: "/var/lib/docker/volumes/x/_data", Destination: "/data", RW: true },
      ],
    });
    expect(r).toEqual({
      privileged: false,
      dockerSocket: true,
      hostPaths: ["/", "/etc/ (writable)"],
      powers: ["host network", "host processes", "CAP_NET_ADMIN", "CAP_SYS_ADMIN", "apparmor=unconfined"],
    });
  });

  it("finds a plain TCP Docker API in daemon.json or the unit's command line", () => {
    expect(dockerTcpHosts('{"hosts":["unix:///var/run/docker.sock","tcp://0.0.0.0:2375"]}', "")).toEqual({ hosts: ["tcp://0.0.0.0:2375"], tlsverify: false });
    expect(dockerTcpHosts("", "{ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2376 --tlsverify ; }")).toEqual({ hosts: ["tcp://0.0.0.0:2376"], tlsverify: true });
    expect(dockerTcpHosts("not json", "/usr/bin/dockerd -H fd://")).toEqual({ hosts: [], tlsverify: false });
  });
});

it("reads os-release with and without quotes", () => {
  expect(osRelease('PRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\nVERSION_CODENAME=noble\n')).toMatchObject({ PRETTY_NAME: "Ubuntu 24.04.1 LTS", ID: "ubuntu", VERSION_CODENAME: "noble" });
});
