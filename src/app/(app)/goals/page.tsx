import { and, eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { healthScorecard, monthBudget, netWorthHistory } from "@/server/insights";
import { loadAccounts } from "@/server/repo";
import { saveGoal, archiveGoal } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Badge, Card, Empty, Field, Money, Notice, PageHeader, Progress } from "@/components/ui";
import { goalStatus, waterfall, emergencyFundTarget, type Goal } from "@/domain/goals";
import { addMonths, formatCents, monthEnd } from "@/domain/money";
import { projectRetirement } from "@/domain/scorecard";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = { emergency_fund: "Emergency fund", savings: "Savings", down_payment: "Down payment", debt_payoff: "Debt payoff", retirement: "Retirement", custom: "Custom" };

export default async function GoalsPage() {
  const ctx = await getContext();
  const db = getDb();
  const rows = db.select().from(schema.goals).where(and(eq(schema.goals.householdId, ctx.householdId), eq(schema.goals.archived, false))).all();
  const accounts = loadAccounts(ctx.householdId);
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const { balanceAt } = netWorthHistory(ctx.householdId, 4);
  const m = ctx.today.slice(0, 7);
  const mbFunds = monthBudget(ctx.householdId, ctx.today.slice(0, 7), ctx.today);
  const earmarkedBy = new Map<string, number>();
  for (const f of mbFunds.statuses) if (f.fund.backingAccountId) earmarkedBy.set(f.fund.backingAccountId, (earmarkedBy.get(f.fund.backingAccountId) ?? 0) + Math.max(0, f.balance));
  const goals: Goal[] = rows.map((g) => {
    const linked = g.linkedAccountIds ?? [];
    const sumAt = (d: string) => linked.reduce((s, id) => s + Math.abs(balanceAt(id, d, acctById.get(id)?.balance ?? 0)), 0);
    // Sinking-fund money parked in a linked account is earmarked, so it doesn't count toward the goal.
    const current = linked.length ? linked.reduce((s, id) => s + Math.abs(acctById.get(id)?.balance ?? 0) - (earmarkedBy.get(id) ?? 0), 0) - g.startingBalance + g.manualProgress : g.manualProgress;
    // Net change in linked balances for each of the last three complete months.
    const recent = linked.length ? [3, 2, 1].map((k) => sumAt(monthEnd(addMonths(m, -k))) - sumAt(monthEnd(addMonths(m, -k - 1)))) : [];
    return { id: g.id, name: g.name, type: g.type as Goal["type"], target: g.target, targetDate: g.targetDate, priority: g.priority, current: Math.max(0, current), recentContributions: recent };
  });
  const statuses = goals.sort((a, b) => a.priority - b.priority).map((g) => goalStatus(g, ctx.today));
  const mb = mbFunds;
  const plan = waterfall(goals, mb.plan.savingsGoals, ctx.today);
  const sc = healthScorecard(ctx.householdId, ctx.today);
  const ef = emergencyFundTarget(sc.essential, { dualIncome: true, variableIncome: false });
  const hasEf = rows.some((g) => g.type === "emergency_fund");
  const r = (ctx.hh.settings.retirement ?? {}) as { ageA?: number; ageB?: number; retireAge?: number; realReturn?: number; retirementSpend?: number };
  const investedNow = sc.nw.byLiquidity.retirement + sc.nw.byLiquidity.invested;
  const age = Math.max(r.ageA ?? 0, r.ageB ?? 0);
  const proj =
    age && r.retireAge
      ? projectRetirement({
          currentInvested: investedNow,
          annualContribution: sc.investedMonthly * 12,
          annualSpendInRetirement: r.retirementSpend ?? sc.trailing3.spending * 12,
          yearsToRetirement: Math.max(0, r.retireAge - age),
          realReturn: r.realReturn ?? 0.05,
        })
      : null;

  return (
    <>
      <PageHeader title="Goals" subtitle="Funded in priority order from your monthly savings plan." />
      {!hasEf && sc.essential > 0 && (
        <div className="mb-4">
          <Notice tone="info">
            Start with an emergency fund: {ef.months} months of essential spending ({formatCents(sc.essential, { noCents: true })}/mo) = <strong>{formatCents(ef.target, { noCents: true })}</strong>. You currently hold{" "}
            {formatCents(sc.liquid, { noCents: true })} in cash and savings (after card balances and {formatCents(sc.earmarked, { noCents: true })} earmarked for sinking funds). Use 6 months if either income is variable or you have one income.
          </Notice>
        </div>
      )}
      {statuses.length === 0 ? (
        <Empty title="No goals yet">Add a goal below. Link it to a savings account to track progress automatically.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {statuses.map((s) => (
            <Card key={s.goal.id} title={s.goal.name} subtitle={TYPE_LABEL[s.goal.type]} action={<Badge tone={s.status === "complete" || s.status === "on_track" ? "good" : s.status === "behind" ? "warn" : "neutral"}>{s.status.replace("_", " ")}</Badge>}>
              <Progress value={s.goal.current} max={s.goal.target} tone="good" />
              <div className="mt-2 flex justify-between text-sm num">
                <span><Money cents={s.goal.current} /> of <Money cents={s.goal.target} /></span>
                <span className="text-muted">{Math.round(s.pct * 100)}%</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div><dt className="text-muted">Pace (3-mo avg)</dt><dd className="num">{formatCents(s.pace, { noCents: true })}/mo</dd></div>
                <div><dt className="text-muted">Needed</dt><dd className="num">{s.requiredMonthly != null ? `${formatCents(s.requiredMonthly, { noCents: true })}/mo` : "No date set"}</dd></div>
                <div><dt className="text-muted">Projected</dt><dd>{s.eta ?? "—"}</dd></div>
                <div><dt className="text-muted">This month's plan</dt><dd className="num">{formatCents(plan.get(s.goal.id) ?? 0, { noCents: true })}</dd></div>
              </dl>
              {s.shortfallPerMonth > 0 && <p className="mt-2 text-xs text-warn">Behind by {formatCents(s.shortfallPerMonth, { noCents: true })}/mo to hit {s.goal.targetDate}.</p>}
              <form action={archiveGoal} className="mt-2"><input type="hidden" name="id" value={s.goal.id} /><button className="text-xs text-muted hover:text-bad">Archive</button></form>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-4" title="Retirement trajectory" subtitle="Deterministic projection in today's dollars. A rule-of-thumb check, not a plan: big decisions deserve a fee-only planner.">
        {proj ? (
          <div className="grid gap-3 sm:grid-cols-4 text-sm">
            <div><div className="text-xs text-muted">FI number (spend ÷ 4%)</div><div className="text-lg font-semibold num">{formatCents(proj.fiNumber, { noCents: true })}</div></div>
            <div><div className="text-xs text-muted">Projected at {r.retireAge}</div><div className="text-lg font-semibold num">{formatCents(proj.projectedAtRetirement, { noCents: true })}</div></div>
            <div><div className="text-xs text-muted">Funded</div><div className={`text-lg font-semibold ${proj.fundedRatio >= 1 ? "text-good" : "text-warn"}`}>{Math.round(proj.fundedRatio * 100)}%</div></div>
            <div><div className="text-xs text-muted">Needed per year</div><div className="text-lg font-semibold num">{formatCents(proj.requiredAnnualContribution, { noCents: true })}</div></div>
            <p className="text-xs text-muted sm:col-span-4">Assumes {Math.round((r.realReturn ?? 0.05) * 1000) / 10}% real return, contributions at your current pace ({formatCents(sc.investedMonthly, { noCents: true })}/mo: payroll plus transfers to investment accounts; cash left in checking isn't counted), and today's spending continuing in retirement unless set. Change assumptions in Settings → Household.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">Add your ages and target retirement age in Settings → Household to see this.</p>
        )}
      </Card>

      <Card className="mt-4" title="Add a goal">
        <ActionForm action={saveGoal} className="grid gap-3 sm:grid-cols-3" resetOnSuccess>
          <Field label="Name"><input name="name" required placeholder="House down payment" /></Field>
          <Field label="Type">
            <select name="type" defaultValue={hasEf ? "savings" : "emergency_fund"}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Target amount"><input name="target" inputMode="decimal" required defaultValue={!hasEf && ef.target ? (ef.target / 100).toFixed(0) : ""} /></Field>
          <Field label="Target date (optional)"><input type="date" name="targetDate" /></Field>
          <Field label="Priority (1 = first)"><input name="priority" type="number" min={1} defaultValue={statuses.length + 1} /></Field>
          <Field label="Linked accounts" hint="Progress = their balance. Ctrl/Cmd-click for several.">
            <select name="linkedAccountIds" multiple size={3}>
              {accounts.filter((a) => !["real_estate", "vehicle"].includes(a.type)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Exclude existing balance" hint="If the linked account already holds money for other things."><input name="startingBalance" inputMode="decimal" placeholder="0" /></Field>
          <Field label="Or manual progress"><input name="manualProgress" inputMode="decimal" placeholder="0" /></Field>
          <div className="sm:col-span-3"><Submit>Add goal</Submit></div>
        </ActionForm>
      </Card>
    </>
  );
}
