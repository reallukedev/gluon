import "server-only";
import { onStart, every } from "../jobs";
import { sampleHost, sampleContainers, sampleFilesystems, sampleSensors, rollup } from "./sampler";

onStart("metrics", () => {
  sampleSensors();
  sampleFilesystems();
  every(2000, sampleHost, { immediate: true });
  every(5000, sampleContainers, { immediate: true });
  every(10_000, sampleSensors);
  every(60_000, sampleFilesystems);
  every(3_600_000, rollup, { immediate: true });
});
