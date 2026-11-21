import { eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { saveHouseholdSettings, createInviteAction } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { InviteButton } from "@/components/InviteButton";
import { Card, Field, Notice, PageHeader, dollarsInput } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HouseholdSettings() {
  const ctx = await getContext();
  const members = getDb().select().from(schema.users).where(eq(schema.users.householdId, ctx.householdId)).all();
  const s = ctx.hh.settings as Record<string, unknown> & { retirement?: Record<string, number> };
  const r = s.retirement ?? {};
  return (
    <>
      <PageHeader title="Household" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Settings">
          <ActionForm action={saveHouseholdSettings} className="grid gap-3 sm:grid-cols-2">
            <Field label="Household name"><input name="name" defaultValue={ctx.hh.name} /></Field>
            <Field label="Time zone" hint="IANA name, e.g. America/New_York"><input name="timezone" defaultValue={ctx.hh.timezone} /></Field>
            <Field label="Partner A name"><input name="nameA" defaultValue={ctx.names.A} /></Field>
            <Field label="Partner B name"><input name="nameB" defaultValue={ctx.names.B} /></Field>
            <Field label="Low balance alert floor" hint="Warn when a checking account is projected below this."><input name="lowBalanceFloor" inputMode="decimal" defaultValue={dollarsInput((s.lowBalanceFloor as number) ?? 50000)} /></Field>
            <Field label="Large transaction alert" hint="Alert on any single transaction above this."><input name="largeTxnThreshold" inputMode="decimal" defaultValue={dollarsInput((s.largeTxnThreshold as number) ?? 50000)} /></Field>
            <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:col-span-2 sm:grid-cols-3">
              <legend className="px-1 text-xs text-muted">Retirement assumptions</legend>
              <Field label={`${ctx.names.A}'s age`}><input name="ageA" type="number" defaultValue={r.ageA ?? ""} /></Field>
              <Field label={`${ctx.names.B}'s age`}><input name="ageB" type="number" defaultValue={r.ageB ?? ""} /></Field>
              <Field label="Target retirement age"><input name="retireAge" type="number" defaultValue={r.retireAge ?? ""} /></Field>
              <Field label="Real return %" hint="After inflation. 4–6% is a common planning range."><input name="realReturn" inputMode="decimal" defaultValue={r.realReturn != null ? (r.realReturn * 100).toString() : "5"} /></Field>
              <Field label="Annual spending in retirement" hint="Today's dollars. Blank = current spending."><input name="retirementSpend" inputMode="decimal" defaultValue={dollarsInput(r.retirementSpend ?? null)} /></Field>
            </fieldset>
            <div className="sm:col-span-2"><Submit>Save</Submit></div>
          </ActionForm>
        </Card>
        <Card title="Members">
          <ul className="mb-4 space-y-1 text-sm">
            {members.map((m) => (
              <li key={m.id} className="flex justify-between"><span>{m.name}</span><span className="text-xs text-muted">{m.email}{m.totpEnabled ? " · 2FA" : ""}</span></li>
            ))}
          </ul>
          {members.length < 2 ? <InviteButton action={createInviteAction} /> : <Notice tone="good">Both partners have joined.</Notice>}
          {members.some((m) => !m.totpEnabled) && <p className="mt-3 text-xs text-warn">Not everyone has two-factor on yet.</p>}
        </Card>
      </div>
    </>
  );
}
