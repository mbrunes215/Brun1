import Link from "next/link";
import { getContext } from "@/server/context";
import { loadPaychecks, monthBudget, trailing } from "@/server/insights";
import { loadAccounts } from "@/server/repo";
import { saveBudgetPlan, copyBudgetFrom, saveFund, contributeFunds, archiveFund } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Badge, Card, Field, LinkButton, Money, Notice, PageHeader, Progress, Stat, dollarsInput } from "@/components/ui";
import { CategoryOptions } from "@/components/CategorySelect";
import { addMonths, formatCents, monthEnd } from "@/domain/money";
import { proposePlan } from "@/domain/budget";
import { monthlyIncomeModel } from "@/domain/income";
import { COMMON_IRREGULAR_EXPENSES } from "@/domain/sinkingFunds";
import { spendingByMonth } from "@/domain/ledger";

export const dynamic = "force-dynamic";

export default async function BudgetPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const month = sp.month ?? ctx.today.slice(0, 7);
  const mb = monthBudget(ctx.householdId, month, ctx.today, ctx.view);
  const { result: r, plan, statuses, categories } = mb;
  const cats = new Map(categories.map((c) => [c.id, c]));
  const fixedCats = categories.filter((c) => c.budgetType === "fixed");
  const flexCats = categories.filter((c) => c.budgetType === "flex");
  const nonMonthlyCats = categories.filter((c) => c.budgetType === "non_monthly");
  const income = monthlyIncomeModel(loadPaychecks(ctx.householdId));
  const t3 = trailing(mb.ledger.lines, ctx.today, 3);

  // Suggestions from history when no plan exists yet.
  const byMonth = spendingByMonth(mb.ledger.lines.filter((l) => l.date < `${month}-01`));
  const history = [...byMonth.entries()].slice(-6).map(([m, s]) => ({ month: m, byCategory: new Map([...s.byCategory].map(([k, v]) => [k, -v])), baselineIncome: s.income }));
  const proposal = history.length >= 2 ? proposePlan(history, categories) : null;
  const lineAmt = new Map(plan.fixed.concat(plan.flexLines ?? []).map((l) => [l.categoryId, l]));
  const suggested = new Map(proposal?.fixed.map((l) => [l.categoryId, l.amount]) ?? []);
  const lastMonthSpend = new Map<string, number>();
  for (const [cid, v] of byMonth.get(addMonths(month, -1))?.byCategory ?? []) if (cid) lastMonthSpend.set(cid, -v);

  const pace = r.flex.pace;
  const fundsSetAside = statuses.reduce((s, f) => s + f.setAside, 0);
  const accounts = loadAccounts(ctx.householdId).filter((a) => a.type === "savings" || a.type === "checking");
  const showFixed = fixedCats.filter((c) => lineAmt.has(c.id) || suggested.has(c.id) || lastMonthSpend.has(c.id));
  const hiddenFixed = fixedCats.filter((c) => !showFixed.includes(c));

  return (
    <>
      <PageHeader
        title="Budget"
        subtitle={new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        actions={
          <>
            <LinkButton href={`/budget?month=${addMonths(month, -1)}`}>← Prev</LinkButton>
            <LinkButton href={`/budget?month=${addMonths(month, 1)}`}>Next →</LinkButton>
          </>
        }
      />

      <Card className="mb-4" title="How this budget works">
        <p className="text-sm text-muted">
          <strong className="text-fg">Income</strong> − <strong className="text-fg">fixed bills</strong> − <strong className="text-fg">sinking funds</strong> (saving monthly for annual and irregular costs) − <strong className="text-fg">savings goals</strong> ={" "}
          <strong className="text-fg">flex</strong>: one number for everything day-to-day. Irregular expenses draw from their fund instead of wrecking the month they land in.
        </p>
      </Card>

      {ctx.view !== "household" && <div className="mb-4"><Notice tone="info">Showing spending for {ctx.view === "joint" ? "joint accounts" : ctx.names[ctx.view]} only. The plan itself is household-wide.</Notice></div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Income" value={formatCents(r.income.actual, { noCents: true })} hint={`of ${formatCents(r.income.expected, { noCents: true })} planned`} />
        <Stat label="Fixed" value={formatCents(r.fixed.spent, { noCents: true })} hint={`of ${formatCents(r.fixed.budgeted, { noCents: true })} planned`} tone={r.fixed.spent > r.fixed.budgeted * 1.05 && r.fixed.budgeted > 0 ? "warn" : undefined} />
        <Stat label="Sinking funds" value={formatCents(fundsSetAside, { noCents: true })} hint="to set aside this month" />
        <Stat label="Savings goals" value={formatCents(plan.savingsGoals, { noCents: true })} hint="planned" />
        <Stat label="Flex left" value={formatCents(r.flex.remaining, { noCents: true })} hint={pace ? `${formatCents(pace.perDayLeft, { noCents: true })}/day · projected ${formatCents(pace.projectedMonthEnd, { noCents: true })}` : `of ${formatCents(r.flex.budgeted + r.flex.carryIn, { noCents: true })}`} tone={r.flex.remaining < 0 ? "bad" : pace?.status === "over" ? "warn" : "good"} />
      </div>
      {mb.hasPlan && r.unallocated < 0 && (
        <div className="mt-3"><Notice tone="bad">The plan is over-allocated by {formatCents(-r.unallocated)}: fixed + funds + savings + flex is more than expected income.</Notice></div>
      )}
      {mb.hasPlan && r.unallocated > 0 && (
        <div className="mt-3"><Notice tone="info">{formatCents(r.unallocated)} of expected income isn't assigned. Consider adding it to savings goals.</Notice></div>
      )}
      {r.uncategorizedSpent > 0 && (
        <div className="mt-3"><Notice tone="warn">{formatCents(r.uncategorizedSpent)} of spending is uncategorized and counted as flex. <Link href="/transactions?filter=uncategorized" className="underline">Categorize</Link></Notice></div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Flexible spending" subtitle="Your categories here are guides; the total is what matters.">
          <Progress value={r.flex.spent} max={r.flex.budgeted + r.flex.carryIn} marker={pace?.expectedSpentByNow} />
          <div className="mb-3 mt-1 flex justify-between text-xs text-muted num">
            <span>{formatCents(r.flex.spent)} spent</span>
            <span>{r.flex.carryIn !== 0 && `incl. ${formatCents(r.flex.carryIn)} rolled over · `}{formatCents(r.flex.budgeted + r.flex.carryIn)}</span>
          </div>
          <ul className="space-y-2 text-sm">
            {r.flex.lines.map((l) => (
              <li key={l.categoryId}>
                <div className="flex justify-between">
                  <Link href={`/transactions?month=${month}&category=${l.categoryId}`} className="hover:underline">{cats.get(l.categoryId)?.name ?? "Other"}</Link>
                  <span className="num text-muted">
                    {formatCents(l.spent, { noCents: true })}
                    {l.budgeted > 0 && ` / ${formatCents(l.budgeted + l.carryIn, { noCents: true })}`}
                  </span>
                </div>
                {l.budgeted > 0 && <Progress value={l.spent} max={l.budgeted + l.carryIn} />}
              </li>
            ))}
            {r.flex.lines.length === 0 && <li className="text-muted">No flexible spending yet this month.</li>}
          </ul>
        </Card>

        <Card title="Fixed bills">
          <ul className="divide-y divide-line text-sm">
            {r.fixed.lines.map((l) => {
              const diff = l.spent - l.budgeted;
              return (
                <li key={l.categoryId} className="flex items-center justify-between py-1.5">
                  <span>{cats.get(l.categoryId)?.name}</span>
                  <span className="flex items-center gap-2 num">
                    <span className="text-muted">{formatCents(l.spent, { noCents: true })} / {formatCents(l.budgeted, { noCents: true })}</span>
                    {l.spent === 0 ? <Badge>Not yet</Badge> : Math.abs(diff) <= l.budgeted * 0.03 ? <Badge tone="good">Paid</Badge> : diff > 0 ? <Badge tone="warn">+{formatCents(diff, { noCents: true })}</Badge> : <Badge tone="good">Paid</Badge>}
                  </span>
                </li>
              );
            })}
            {r.fixed.lines.length === 0 && <li className="py-1.5 text-muted">No fixed bills planned yet. Add them below.</li>}
          </ul>
          {r.nonMonthly.spent > 0 && (
            <div className="mt-3 border-t border-line pt-3 text-sm">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Paid from sinking funds this month</div>
              {[...r.nonMonthly.byCategory.entries()].map(([cid, amt]) => (
                <div key={cid} className="flex justify-between">
                  <span>{cats.get(cid)?.name}</span>
                  <Money cents={amt} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Sinking funds */}
      <Card className="mt-4" title={<span id="funds">Sinking funds</span>} subtitle="Saving monthly for non-monthly costs. Balances grow with your set-asides and shrink when you spend in the linked categories.">
        {statuses.length > 0 ? (
          <form action={contributeFunds}>
            <input type="hidden" name="month" value={month} />
            <input type="hidden" name="date" value={ctx.today < monthEnd(month) ? ctx.today : monthEnd(month)} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1">Fund</th>
                    <th>Due</th>
                    <th className="text-right">Balance</th>
                    <th className="text-right">Target</th>
                    <th className="w-32 text-right">Set aside now</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {statuses.map((f) => (
                    <tr key={f.fund.id} className="border-t border-line">
                      <td className="py-2">
                        <div className="font-medium">{f.fund.name}</div>
                        <div className="mt-1 w-40"><Progress value={f.balance} max={f.fund.target} tone={f.status === "behind" ? "warn" : f.status === "overdrawn" ? "bad" : "good"} /></div>
                      </td>
                      <td className="text-muted">
                        {f.due} <span className="text-xs">({f.monthsLeft} mo)</span>
                        <div><Badge tone={f.status === "funded" ? "good" : f.status === "on_track" ? "accent" : f.status === "behind" ? "warn" : "bad"}>{f.status.replace("_", " ")}</Badge></div>
                      </td>
                      <td className="text-right num"><Money cents={f.balance} /></td>
                      <td className="text-right num"><Money cents={f.fund.target} /></td>
                      <td className="text-right">
                        <input type="hidden" name="fundId" value={f.fund.id} />
                        <input name="amount" inputMode="decimal" defaultValue={dollarsInput(f.setAside)} className="!w-28 text-right" aria-label={`Contribution to ${f.fund.name}`} />
                      </td>
                      <td className="pl-2 text-right">
                        <button formAction={archiveFund} name="id" value={f.fund.id} className="text-xs text-muted hover:text-bad">Archive</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-muted">Record set-asides once a month (ideally when you move the cash to savings). Suggested amounts fully fund each bill before it's due.</p>
              <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">Record set-asides</button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted">No funds yet. Most households need 5 to 10. Start with the checklist below.</p>
        )}

        <details className="mt-4 rounded-lg border border-line p-3" open={statuses.length === 0}>
          <summary className="cursor-pointer text-sm font-medium">Add a sinking fund</summary>
          <ActionForm action={saveFund} className="mt-3 grid gap-3 sm:grid-cols-3" resetOnSuccess>
            <input type="hidden" name="today" value={ctx.today} />
            <Field label="Name">
              <input name="name" list="irregular" required placeholder="Car insurance" />
              <datalist id="irregular">
                {COMMON_IRREGULAR_EXPENSES.map((e) => <option key={e.name} value={e.name}>{e.hint}</option>)}
              </datalist>
            </Field>
            <Field label="Amount per occurrence">
              <input name="target" inputMode="decimal" required />
            </Field>
            <Field label="Next due">
              <input type="date" name="nextDue" required />
            </Field>
            <Field label="Repeats">
              <select name="recurrence" defaultValue="annual">
                <option value="annual">Yearly</option>
                <option value="semiannual">Every 6 months</option>
                <option value="quarterly">Quarterly</option>
                <option value="none">One time</option>
              </select>
            </Field>
            <Field label="Spending categories it pays for" hint="Ctrl/Cmd-click to pick several.">
              <select name="categoryIds" multiple size={4}>
                <CategoryOptions categories={[...nonMonthlyCats, ...flexCats]} includeNone={false} />
              </select>
            </Field>
            <div className="space-y-3">
              <Field label="Already saved">
                <input name="startingBalance" inputMode="decimal" placeholder="0" />
              </Field>
              <Field label="Cash held in">
                <select name="backingAccountId">
                  <option value="">—</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="sm:col-span-3">
              <Submit>Add fund</Submit>
            </div>
          </ActionForm>
          <div className="mt-3 text-xs text-muted">
            Commonly forgotten: {COMMON_IRREGULAR_EXPENSES.map((e) => e.name).join(" · ")}
          </div>
        </details>
      </Card>

      {/* Plan editor */}
      <Card className="mt-4" title="Plan for this month" subtitle={!mb.hasPlan && proposal ? "Pre-filled from your last few months (median fixed costs, conservative income). Adjust and save." : undefined}
        action={
          <form action={copyBudgetFrom}>
            <input type="hidden" name="month" value={month} />
            <button className="text-xs text-accent underline">Copy last month's plan</button>
          </form>
        }>
        <ActionForm action={saveBudgetPlan} className="space-y-5">
          <input type="hidden" name="month" value={month} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Expected take-home income" hint={income.net ? `Paychecks say ${formatCents(income.net, { noCents: true })}/mo net.` : t3.income ? `Last 3 months averaged ${formatCents(t3.income, { noCents: true })}.` : "Add paychecks in Settings for a better estimate."}>
              <input name="expectedIncome" inputMode="decimal" defaultValue={dollarsInput(mb.hasPlan ? plan.expectedIncome : income.net || proposal?.expectedIncome || null)} />
            </Field>
            <Field label="Monthly savings goals" hint="Transfers to savings, brokerage, extra debt payments. Payroll 401(k) is already out of take-home.">
              <input name="savingsGoals" inputMode="decimal" defaultValue={dollarsInput(plan.savingsGoals || null)} />
            </Field>
            <Field label="Flex budget" hint={`Leave blank to use what's left: ${formatCents(mb.derivedFlex, { noCents: true })}.`}>
              <input name="flexTotal" inputMode="decimal" defaultValue={dollarsInput(plan.flexTotal ?? (!mb.hasPlan ? proposal?.flexTotal ?? null : null))} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" name="flexRollover" defaultChecked={plan.flexRollover} /> Roll unspent (or overspent) flex into next month
          </label>

          <div>
            <h3 className="mb-2 text-sm font-semibold">Fixed bills</h3>
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {showFixed.map((c) => (
                <div key={c.id} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2 text-sm">
                  <span>
                    {c.name}
                    {lastMonthSpend.get(c.id) ? <span className="ml-1 text-xs text-muted">(last mo {formatCents(lastMonthSpend.get(c.id)!, { noCents: true })})</span> : null}
                  </span>
                  <input type="hidden" name="lineCategory" value={c.id} />
                  <input name="lineAmount" inputMode="decimal" defaultValue={dollarsInput(lineAmt.get(c.id)?.amount ?? (!mb.hasPlan ? suggested.get(c.id) ?? null : null))} aria-label={c.name} />
                  <label className="flex items-center gap-1 text-[11px]" title="Roll over unspent">
                    <input type="checkbox" name="lineRollover" value={c.id} defaultChecked={lineAmt.get(c.id)?.rollover} /> roll
                  </label>
                </div>
              ))}
            </div>
            {hiddenFixed.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-accent">More fixed categories ({hiddenFixed.length})</summary>
                <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {hiddenFixed.map((c) => (
                    <div key={c.id} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2 text-sm">
                      <span>{c.name}</span>
                      <input type="hidden" name="lineCategory" value={c.id} />
                      <input name="lineAmount" inputMode="decimal" aria-label={c.name} />
                      <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" name="lineRollover" value={c.id} /> roll</label>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-semibold">Optional: flex category guides</summary>
            <p className="mt-1 text-xs text-muted">Targets for categories you want to watch (dining is the usual one). They don't change the flex total.</p>
            <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {flexCats.filter((c) => !c.isPersonalAllowance || true).map((c) => (
                <div key={c.id} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2 text-sm">
                  <span>{c.name}</span>
                  <input type="hidden" name="lineCategory" value={c.id} />
                  <input name="lineAmount" inputMode="decimal" defaultValue={dollarsInput(lineAmt.get(c.id)?.amount ?? null)} aria-label={c.name} />
                  <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" name="lineRollover" value={c.id} defaultChecked={lineAmt.get(c.id)?.rollover} /> roll</label>
                </div>
              ))}
            </div>
          </details>
          <Submit>Save plan</Submit>
        </ActionForm>
      </Card>
    </>
  );
}
