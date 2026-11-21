import { desc, eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { markAlertsRead } from "@/server/actions";
import { Card, Empty, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const ctx = await getContext();
  const alerts = getDb().select().from(schema.alerts).where(eq(schema.alerts.householdId, ctx.householdId)).orderBy(desc(schema.alerts.createdAt)).all().filter((a) => !a.userSlot || a.userSlot === ctx.viewer).slice(0, 100);
  return (
    <>
      <PageHeader title="Alerts" actions={<form action={markAlertsRead}><button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2">Mark all read</button></form>} />
      {alerts.length === 0 ? <Empty title="No alerts">Checks run after each sync: low projected balance, large transactions, budget pace, bills, price increases, promo APRs, utilization, and sync health.</Empty> : (
        <Card>
          <ul className="divide-y divide-line">
            {alerts.map((a) => (
              <li key={a.id} className={`py-2 ${a.readAt ? "opacity-60" : ""}`}>
                <div className="text-sm font-medium">{a.title}</div>
                {a.body && <div className="text-sm text-muted">{a.body}</div>}
                <div className="text-[11px] text-muted">{a.createdAt}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
