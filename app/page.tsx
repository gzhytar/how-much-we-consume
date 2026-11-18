import { dashboardAllowed } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import Dashboard from "./Dashboard";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const cfg = getConfig();
  if (!dashboardAllowed(cfg.dashboardToken, t)) {
    return (
      <main className="denied">
        <p>Přístup jen s platným odkazem.</p>
      </main>
    );
  }
  return <Dashboard token={t ?? ""} />;
}
