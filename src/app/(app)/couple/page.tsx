import { and, eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { coupleSummary, loadPaychecks } from "@/server/insights";
import { loadCategories, toCategory } from "@/server/repo";
import { saveSplitPolicy, recordSettlement, toggleMilestone } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { CategoryOptions } from "@/components/CategorySelect";
import { Card, Field, Money, Notice, PageHeader, Progress, Stat, dollarsInput, pct } from "@/components/ui";
import { Bars } from "@/components/charts";
import { DEFAULT_MERGE_MILESTONES, shareOfA } from "@/domain/couple";
import { monthlyIncomeModel } from "@/domain/income";
import { formatCents } from "@/domain/money";

export const dynamic = "force-dynamic";

export default async function CouplePage() {
  const ctx = await getContext();
  const c = coupleSummary(ctx.householdId, ctx.today);
  const { names, policy } = c;
  const categories = loadCategories(ctx.householdId).map(toCategory);
  const cats = new Map(categories.map((x) => [x.id, x]));
  const done = new Map(getDb().select().from(schema.mergeMilestones).where(eq(schema.mergeMilestones.householdId, ctx.householdId)).all().map((m) => [m.key, m.doneAt]));
  const doneCount = DEFAULT_MERGE_MILESTONES.filter((m) => done.get(m.key)).length;
  const paychecks = loadPaychecks(ctx.householdId);
  const incA = monthlyIncomeModel(paychecks.filter((p) => p.owner === "A")).net;
  const incB = monthlyIncomeModel(paychecks.filter((p) => p.owner === "B")).net;
  const sA = shareOfA(policy.default, policy);
  const tm = c.thisMonth;
  const overrides = Object.entries(policy.byCategory ?? {});
  const recentSettlements = getDb().select().from(schema.settlements).where(and(eq(schema.settlements.householdId, ctx.householdId))).all().slice(-5).reverse();

  return (
    <>
      <PageHeader title="Us" subtitle="Fair shared costs today, and a deliberate path to fully joint finances." />

      {policy.fullyJoint ? (
        <Notice tone="good">You're fully joint. Settle-up is retired; history is kept below.</Notice>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Settle-up balance"
            value={c.all.balance === 0 ? "Even" : formatCents(Math.abs(c.all.balance), { noCents: true })}
            hint={c.all.balance === 0 ? "All square" : `${c.all.balance > 0 ? names.B : names.A} owes ${c.all.balance > 0 ? names.A : names.B}`}
          />
          <Stat label="Shared costs this month" value={formatCents(tm.sharedTotal, { noCents: true })} hint={`${names.A} paid ${formatCents(tm.paidByA, { noCents: true })} · ${names.B} paid ${formatCents(tm.paidByB, { noCents: true })}`} />
          <Stat label="Split" value={`${Math.round(sA * 100)} / ${Math.round((1 - sA) * 100)}`} hint={`${names.A} / ${names.B} · ${policy.default.mode === "income" ? "by income" : policy.default.mode === "equal" ? "50/50" : "custom"}`} />
        </div>
      )}

      {!policy.fullyJoint && tm.sharedTotal > 0 && (
        <Card className="mt-4" title="This month's statement">
          <p className="text-sm">
            Shared costs were <Money cents={tm.sharedTotal} />. {names.A}'s fair share is <Money cents={tm.fairShareA} /> and they paid <Money cents={tm.paidByA} />; {names.B}'s fair share is{" "}
            <Money cents={tm.fairShareB} /> and they paid <Money cents={tm.paidByB} />.{" "}
            {tm.balance !== 0 && (
              <strong>
                For this month alone, {tm.balance > 0 ? names.B : names.A} owes {tm.balance > 0 ? names.A : names.B} <Money cents={Math.abs(tm.balance)} />.
              </strong>
            )}
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-accent">Line items ({tm.lines.length})</summary>
            <ul className="mt-2 divide-y divide-line text-sm">
              {tm.lines.map((l) => (
                <li key={l.txnId} className="flex justify-between py-1">
                  <span>{l.date} · paid by {l.paidBy === "A" ? names.A : names.B}</span>
                  <span className="num"><Money cents={l.spent} /> <span className="text-xs text-muted">({formatCents(l.shareA)} / {formatCents(l.shareB)})</span></span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Path to joint" subtitle={`${doneCount} of ${DEFAULT_MERGE_MILESTONES.length} milestones`}>
          <Progress value={doneCount} max={DEFAULT_MERGE_MILESTONES.length} tone="good" />
          <ul className="mt-3 space-y-2">
            {DEFAULT_MERGE_MILESTONES.map((m) => (
              <li key={m.key}>
                <form action={toggleMilestone} className="flex items-start gap-2">
                  <input type="hidden" name="key" value={m.key} />
                  <button className={`mt-0.5 h-4 w-4 shrink-0 rounded border ${done.get(m.key) ? "border-good bg-good" : "border-line"}`} aria-label={done.get(m.key) ? "Mark not done" : "Mark done"}>
                    {done.get(m.key) && <svg viewBox="0 0 16 16" className="h-4 w-4 text-white"><path d="M4 8l3 3 5-6" stroke="currentColor" strokeWidth="2" fill="none" /></svg>}
                  </button>
                  <div>
                    <div className={`text-sm ${done.get(m.key) ? "text-muted line-through" : ""}`}>{m.title}</div>
                    <div className="text-xs text-muted">{m.detail}</div>
                  </div>
                </form>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Spending through joint accounts" subtitle="The share of household spending that flows through joint accounts. It should climb toward 100% as you merge.">
          <Bars data={c.jointTrend.map((j) => ({ label: new Date(j.month + "-15").toLocaleDateString("en-US", { month: "short" }), values: [{ name: "Joint", value: Math.round(j.share * 10000), color: "var(--chart-1)" }] }))} height={150} />
          <p className="mt-1 text-sm">This month: <strong>{pct(c.jointTrend.at(-1)?.share ?? 0)}</strong></p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Split policy" subtitle="Planners often suggest splitting by income when incomes differ. Each person keeps the same share of their pay for shared life.">
          <ActionForm action={saveSplitPolicy} className="space-y-3">
            <Field label="Default split">
              <select name="mode" defaultValue={policy.default.mode}>
                <option value="income">Proportional to income</option>
                <option value="equal">50 / 50</option>
                <option value="custom">Custom percentage</option>
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={`${names.A}'s % (custom)`}>
                <input name="shareA" inputMode="decimal" defaultValue={policy.default.shareA != null ? Math.round(policy.default.shareA * 100) : ""} />
              </Field>
              <Field label={`${names.A} monthly income`} hint={incA ? `Paychecks: ${formatCents(incA, { noCents: true })}` : "From paychecks if blank"}>
                <input name="incomeA" inputMode="decimal" defaultValue={dollarsInput(policy.incomeA || null)} />
              </Field>
              <Field label={`${names.B} monthly income`} hint={incB ? `Paychecks: ${formatCents(incB, { noCents: true })}` : "From paychecks if blank"}>
                <input name="incomeB" inputMode="decimal" defaultValue={dollarsInput(policy.incomeB || null)} />
              </Field>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted">Category exceptions (e.g. groceries 50/50, rent by income)</div>
              {[...overrides, ["", { mode: "" as const }], ["", { mode: "" as const }]].map(([cid, rule], i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_9rem_5rem] gap-2">
                  <select name="overrideCategory" defaultValue={cid as string} aria-label="Category">
                    <CategoryOptions categories={categories} />
                  </select>
                  <select name="overrideMode" defaultValue={(rule as { mode: string }).mode} aria-label="Split">
                    <option value="">—</option>
                    <option value="equal">50 / 50</option>
                    <option value="income">By income</option>
                    <option value="custom">Custom</option>
                  </select>
                  <input name="overrideShareA" placeholder={`${names.A} %`} defaultValue={(rule as { shareA?: number }).shareA != null ? Math.round((rule as { shareA: number }).shareA * 100) : ""} aria-label="Custom share" />
                </div>
              ))}
              {overrides.length > 0 && <p className="text-xs text-muted">Current: {overrides.map(([cid, r]) => `${cats.get(cid)?.name}: ${r.mode}`).join(", ")}</p>}
            </div>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" name="fullyJoint" defaultChecked={policy.fullyJoint} /> We're fully joint now (retire settle-up)
            </label>
            <Submit>Save policy</Submit>
          </ActionForm>
        </Card>

        <Card title="Record a settle-up" subtitle="Or mark the Venmo/Zelle transaction as 'Settle-up payment' and it's recorded automatically.">
          <ActionForm action={recordSettlement} className="grid gap-3 sm:grid-cols-2" resetOnSuccess>
            <Field label="Who paid">
              <select name="from" defaultValue={c.all.balance > 0 ? "B" : "A"}>
                <option value="A">{names.A} paid {names.B}</option>
                <option value="B">{names.B} paid {names.A}</option>
              </select>
            </Field>
            <Field label="Amount">
              <input name="amount" inputMode="decimal" defaultValue={dollarsInput(Math.abs(c.all.balance) || null)} />
            </Field>
            <Field label="Date">
              <input type="date" name="date" defaultValue={ctx.today} />
            </Field>
            <Field label="Note">
              <input name="note" />
            </Field>
            <div className="sm:col-span-2"><Submit>Record</Submit></div>
          </ActionForm>
          {recentSettlements.length > 0 && (
            <ul className="mt-4 divide-y divide-line text-sm">
              {recentSettlements.map((s) => (
                <li key={s.id} className="flex justify-between py-1">
                  <span>{s.date} · {s.from === "A" ? names.A : names.B} → {s.to === "A" ? names.A : names.B}</span>
                  <Money cents={s.amount} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="How to mark shared costs">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>On a transaction, tick <em>Shared household expense</em> when one of you paid for something you both use from a personal account.</li>
          <li>Create a rule (e.g. merchant = your grocery store → shared) so it happens automatically.</li>
          <li>Spending from joint accounts is already shared money and isn't part of settle-up.</li>
          <li>Personal fun money stays private: your partner sees the total, not the line items.</li>
        </ul>
      </Card>
    </>
  );
}
