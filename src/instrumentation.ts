export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startJobs } = await import("./server/jobs");
  await startJobs();
  // Before the first request, so containers never count as home while Docker is first asked.
  const { refreshDockerNetworks } = await import("./server/net-zone");
  await refreshDockerNetworks();
}
