import { requireAdmin } from "@/server/auth/session";
import { DiskView } from "@/components/docker/DiskView";

export const metadata = { title: "Docker disk use" };

/** Docker's disk-usage report can take a while on big volumes, so the page measures on the client. */
export default async function DockerDiskPage() {
  await requireAdmin();
  return <DiskView />;
}
