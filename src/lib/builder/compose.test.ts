import { describe, expect, it } from "vitest";
import { parseCompose, readService, readNetworks, setCpus, setGpu, setHealth, setHostNetwork, setLabels, setMemory, setServiceNetworks, stringify } from "./compose";

const edit = (text: string, fn: (doc: ReturnType<typeof parseCompose>["doc"]) => void) => {
  const p = parseCompose(text);
  fn(p.doc);
  return stringify(p.doc);
};
const js = (text: string) => parseCompose(text).doc.toJS() as { services: Record<string, Record<string, unknown>>; networks?: Record<string, unknown> };

const ONE = "services:\n  app:\n    image: ollama/ollama\n";

describe("GPU, CPU and memory", () => {
  it("adds and removes the NVIDIA reservation, leaving no empty deploy behind", () => {
    const on = edit(ONE, (d) => setGpu(d, "app", true));
    expect(js(on).services.app!.deploy).toEqual({ resources: { reservations: { devices: [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }] } } });
    expect(readService(parseCompose(on).doc, "app").gpu).toBe(true);
    const off = edit(on, (d) => setGpu(d, "app", false));
    expect(js(off).services.app!.deploy).toBeUndefined();
  });

  it("keeps other device reservations and other deploy settings when the GPU goes", () => {
    const text = `services:
  app:
    image: x
    deploy:
      replicas: 1
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
            - driver: cdi
              device_ids: [vendor.com/device=0]
`;
    const out = js(edit(text, (d) => setGpu(d, "app", false))).services.app!;
    expect(out.deploy).toEqual({ replicas: 1, resources: { reservations: { devices: [{ driver: "cdi", device_ids: ["vendor.com/device=0"] }] } } });
    // replicas isn't something the form shows, so deploy is listed as set in Compose.
    expect(readService(parseCompose(text).doc, "app").extraKeys).toContain("deploy");
  });

  it("moves a deploy CPU limit to cpus: and drops it when cleared", () => {
    const text = "services:\n  app:\n    image: x\n    deploy:\n      resources:\n        limits:\n          cpus: '0.5'\n          memory: 512M\n";
    expect(readService(parseCompose(text).doc, "app")).toMatchObject({ cpus: "0.5", memory: "512M" });
    const set = edit(text, (d) => setCpus(d, "app", "1.5"));
    expect(js(set).services.app).toMatchObject({ cpus: 1.5, deploy: { resources: { limits: { memory: "512M" } } } });
    const cleared = edit(edit(set, (d) => setCpus(d, "app", "")), (d) => setMemory(d, "app", ""));
    expect(js(cleared).services.app).toEqual({ image: "x" });
  });
});

describe("networks", () => {
  it("joins an existing network next to the app's own and declares it external", () => {
    const out = edit(ONE, (d) => setServiceNetworks(d, "app", ["default", "proxy"], ["proxy"]));
    expect(js(out).services.app!.networks).toEqual(["default", "proxy"]);
    expect(readNetworks(parseCompose(out).doc)).toEqual([{ name: "proxy", external: true }]);
  });

  it("removes declarations nobody uses and the key when only the app's own is left", () => {
    const joined = edit(ONE, (d) => setServiceNetworks(d, "app", ["default", "proxy"], ["proxy"]));
    const back = edit(joined, (d) => setServiceNetworks(d, "app", ["default"]));
    expect(js(back)).toEqual({ services: { app: { image: "ollama/ollama" } } });
  });

  it("keeps aliases written in the map form", () => {
    const text = "services:\n  app:\n    image: x\n    networks:\n      proxy:\n        aliases: [web]\nnetworks:\n  proxy:\n    external: true\n";
    const out = edit(text, (d) => setServiceNetworks(d, "app", ["proxy", "backend"]));
    expect(js(out).services.app!.networks).toEqual({ proxy: { aliases: ["web"] }, backend: null });
    expect(js(out).networks).toEqual({ proxy: { external: true }, backend: {} });
  });

  it("leaves custom networks when the service moves to the server's network", () => {
    const joined = edit(ONE, (d) => setServiceNetworks(d, "app", ["default", "proxy"], ["proxy"]));
    expect(js(edit(joined, (d) => setHostNetwork(d, "app", true)))).toEqual({ services: { app: { image: "ollama/ollama", network_mode: "host" } } });
  });
});

describe("labels and health checks", () => {
  it("writes labels as quoted strings and reads the list form", () => {
    const out = edit(ONE, (d) => setLabels(d, "app", [{ key: "traefik.enable", value: "true" }, { key: "", value: "skipped" }]));
    expect(out).toContain('traefik.enable: "true"');
    const list = "services:\n  app:\n    image: x\n    labels:\n      - a=b\n      - flag\n";
    expect(readService(parseCompose(list).doc, "app").labels).toEqual([{ key: "a", value: "b" }, { key: "flag", value: "" }]);
  });

  it("writes every health check field, and timings alone keep the image's own test", () => {
    const full = edit(ONE, (d) => setHealth(d, "app", { test: "curl -f localhost", interval: "30s", timeout: "5s", retries: "3", startPeriod: "1m" }));
    expect(js(full).services.app!.healthcheck).toEqual({ test: ["CMD-SHELL", "curl -f localhost"], interval: "30s", timeout: "5s", retries: 3, start_period: "1m" });
    const timings = edit(ONE, (d) => setHealth(d, "app", { test: "", interval: "1m", timeout: "", retries: "", startPeriod: "" }));
    expect(js(timings).services.app!.healthcheck).toEqual({ interval: "1m" });
    const none = edit(full, (d) => setHealth(d, "app", { test: "", interval: "", timeout: "", retries: "", startPeriod: "" }));
    expect(js(none).services.app!.healthcheck).toBeUndefined();
  });
});
