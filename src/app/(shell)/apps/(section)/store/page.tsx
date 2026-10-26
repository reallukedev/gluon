import { requireAdmin } from "@/server/auth/session";
import { StoreView } from "@/components/store/StoreView";

export const metadata = { title: "App store" };

export default async function StorePage() {
  await requireAdmin();
  return <StoreView />;
}
