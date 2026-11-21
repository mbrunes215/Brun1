import { eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { connectSimpleFin, syncNow, removeConnection } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Badge, Card, Field, Notice, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const ctx = await getContext();
  const db = getDb();
  const conns = db.select().from(schema.connections).where(eq(schema.connections.householdId, ctx.householdId)).all();
  const accounts = db.select().from(schema.accounts).where(eq(schema.accounts.householdId, ctx.householdId)).all();
  return (
    <>
      <PageHeader title="Bank connections" subtitle="Read-only sync through SimpleFIN Bridge. Hearth can never move money." />
      {!ctx.user.totpEnabled && <div className="mb-4"><Notice tone="warn">Turn on two-factor authentication in Security before connecting banks.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connect SimpleFIN">
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Create an account at <a className="text-accent underline" href="https://beta-bridge.simplefin.org" target="_blank" rel="noreferrer">SimpleFIN Bridge</a> and connect your banks there (about $15/year).</li>
            <li>Check that each of your banks is supported before paying.</li>
            <li>Create a <em>setup token</em> for Hearth and paste it below. It can be used once.</li>
          </ol>
          <ActionForm action={connectSimpleFin} className="space-y-3">
            <Field label="Setup token"><textarea name="token" rows={3} required className="font-mono text-xs" /></Field>
            <Field label="Label"><input name="label" placeholder="e.g. Matt's banks" /></Field>
            <Submit>Connect and sync</Submit>
          </ActionForm>
          <p className="mt-3 text-xs text-muted">The access URL is encrypted at rest with your APP_SECRET. Syncs run daily at about 6am; SimpleFIN limits how often data can be requested, and most banks only update once a day.</p>
        </Card>
        <Card title="Connections">
          {conns.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
            <ul className="space-y-4">
              {conns.map((c) => (
                <li key={c.id} className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{c.label}</span>
                    {c.lastError ? <Badge tone="bad">Error</Badge> : c.lastSyncedAt ? <Badge tone="good">OK</Badge> : <Badge>Never synced</Badge>}
                  </div>
                  <div className="text-xs text-muted">Last sync: {c.lastSyncedAt ? new Date(c.lastSyncedAt).toLocaleString() : "never"} · {accounts.filter((a) => a.connectionId === c.id).length} accounts</div>
                  {c.lastError && <p className="mt-1 text-xs text-bad">{c.lastError}</p>}
                  <div className="mt-2 flex items-start gap-3">
                    <ActionForm action={syncNow}>
                      <input type="hidden" name="id" value={c.id} />
                      <Submit variant="secondary">Sync now</Submit>
                    </ActionForm>
                    <form action={removeConnection}>
                      <input type="hidden" name="id" value={c.id} />
                      <button className="mt-1.5 text-xs text-bad underline">Disconnect (keeps history)</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
