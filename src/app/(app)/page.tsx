import Link from "next/link";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { healthScorecard, monthBudget, netWorthHistory, recurringSeries, coupleSummary } from "@/server/insights";
import { Badge, Card, Empty, LinkButton, Money, Notice, PageHeader, Progress, Stat, pct } from "@/components/ui";
import { LineChart } from "@/components/charts";
import { addDays, daysBetween, formatCents } from "@/domain/money";
import { summarize } from "@/domain/ledger";
import { occurrencesBetween } from "@/domain/recurring";

export const dynamic = "force-dynamic";

const statusTone = { good: "good", ok: "warn", attention: "bad", unknown: "neutral" } as const;
const statusWord = { good: "Healthy", ok: "Watch", attention: "Needs attention", unknown: "Not enough data" } as const;

export default async function Dashboard() {
  const ctx = await getContext();
  const db = getDb();
  const month = ctx.today.slice(0, 7);
  const accounts = db.select().from(schema.accounts).where(eq(schema.accounts.householdId, ctx.householdId)).all();

  if (accounts.length === 0) {
    return (
      <>
        <PageHeader title={`Welcome, ${ctx.user.name}`} subtitle="Let's get your money picture set up. About 15 minutes." />
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="1. Connect your banks">
            <p className="text-sm text-muted">Use a SimpleFIN Bridge token for automatic daily sync, or import CSV/OFX files from your bank.</p>
            <div className="mt-3 flex gap-2">
              <LinkButton href="/settings/connections" variant="primary">Connect SimpleFIN</LinkButton>
              <LinkButton href="/import">Import a file</LinkButton>
            </div>
          </Card>
          <Card title="2. Invite your partner">
            <p className="text-sm text-muted">Each of you gets your own login, your own view, and shared household totals.</p>
            <div className="mt-3"><LinkButton href="/settings/household">Create invite link</LinkButton></div>
          </Card>
          <Card title="3. Add paychecks">
            <p className="text-sm text-muted">Gross pay and pre-tax deductions make your savings rate accurate (most apps miss your 401k).</p>
            <div className="mt-3"><LinkButton href="/settings/income">Add paychecks</LinkButton></div>
          </Card>
          <Card title="4. Add manual assets & debts">
            <p className="text-sm text-muted">Home, cars, and any loan SimpleFIN can't see, so net worth is complete.</p>
            <div className="mt-3"><LinkButton href="/accounts/new">Add an account</LinkButton></div>
          </Card>
        </div>
      </>
    );
  }

  const sc = healthScorecard(ctx.householdId, ctx.today);
  const mb = monthBudget(ctx.householdId, month, ctx.today, ctx.view);
  const nw = netWorthHistory(ctx.householdId, 12).points;
  const series = recurringSeries(ctx.householdId, ctx.today).filter((s) => s.direction === "outflow" && s.status !== "cancelled");
  const couple = coupleSummary(ctx.householdId, ctx.today);
  const thisMonth = summarize(mb.ledger.lines, { start: `${month}-01`, end: ctx.today, owner: ctx.view });
  const upcoming = series
    .flatMap((s) => occurrencesBetween(s, ctx.today, addDays(ctx.today, 14)).map((d) => ({ date: d, s })))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);
  const conns = db.select().from(schema.connections).where(eq(schema.connections.householdId, ctx.householdId)).all();
  const syncErr = conns.filter((c) => c.lastError);
  const stale = conns.filter((c) => !c.lastSyncedAt || daysBetween(c.lastSyncedAt.slice(0, 10), ctx.today) > 2);
  const unreviewed = db.select({ id: schema.transactions.id }).from(schema.transactions).where(and(eq(schema.transactions.householdId, ctx.householdId), isNull(schema.transactions.reviewedAt), eq(schema.transactions.isHidden, false))).all().length;
  const dupes = db.select({ id: schema.transactions.id }).from(schema.transactions).where(and(eq(schema.transactions.householdId, ctx.householdId), isNotNull(schema.transactions.possibleDuplicateOf))).all().length;
  const flex = mb.result.flex;
  const pace = flex.pace;
  const behindFunds = mb.statuses.filter((f) => f.status === "behind" || f.status === "overdrawn");
  const last = nw.at(-1)!;
  const first = nw.find((p) => p.netWorth !== 0) ?? nw[0]!;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${new Date(ctx.today + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`}
        actions={<LinkButton href="/transactions?filter=unreviewed" variant={unreviewed ? "primary" : "secondary"}>Review {unreviewed} transactions</LinkButton>}
      />

      <div className="mb-4 space-y-2">
        {syncErr.map((c) => (
          <Notice key={c.id} tone="bad">Bank sync problem: {c.lastError} <Link className="underline" href="/settings/connections">Fix</Link></Notice>
        ))}
        {stale.length > 0 && syncErr.length === 0 && <Notice tone="warn">Bank data hasn't synced in over 2 days. <Link className="underline" href="/settings/connections">Sync now</Link></Notice>}
        {dupes > 0 && <Notice tone="warn">{dupes} possible duplicate transaction{dupes > 1 ? "s" : ""} need a look. <Link className="underline" href="/transactions?filter=duplicates">Review</Link></Notice>}
      </div>

      {/* Headline: this month */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Flex left this month"
          value={formatCents(flex.remaining, { noCents: true })}
          tone={flex.remaining < 0 ? "bad" : pace?.status === "over" ? "warn" : "good"}
          hint={mb.hasPlan ? (pace ? `${formatCents(pace.perDayLeft, { noCents: true })}/day for ${pace.daysLeft} days · ${pace.status === "over" ? "spending ahead of pace" : pace.status === "under" ? "under pace" : "on pace"}` : "") : <Link className="underline" href="/budget">Set up your plan</Link>}
        />
        <Stat label="Income so far" value={formatCents(thisMonth.income, { noCents: true })} hint={mb.plan.expectedIncome ? `of ${formatCents(mb.plan.expectedIncome, { noCents: true })} expected` : undefined} />
        <Stat label="Spent so far" value={formatCents(thisMonth.spending, { noCents: true })} hint={`${formatCents(mb.result.fixed.spent, { noCents: true })} fixed · ${formatCents(flex.spent, { noCents: true })} flex · ${formatCents(mb.result.nonMonthly.spent, { noCents: true })} from funds`} />
        <Stat label="Net worth" value={formatCents(last.netWorth, { noCents: true })} hint={<Money cents={last.netWorth - first.netWorth} sign noCents colored className="font-medium" />} />
      </div>

      {mb.hasPlan && (
        <Card className="mt-4" title="Flexible spending" subtitle="One number for day-to-day spending. The line marks where you'd be on a straight-line pace.">
          <Progress value={flex.spent} max={flex.budgeted + flex.carryIn} marker={pace?.expectedSpentByNow} />
          <div className="mt-2 flex justify-between text-xs text-muted num">
            <span>{formatCents(flex.spent, { noCents: true })} spent</span>
            <span>{formatCents(flex.budgeted + flex.carryIn, { noCents: true })} budget</span>
          </div>
        </Card>
      )}

      {/* Scorecard */}
      <Card className="mt-4" title="Financial health" subtitle="Benchmarks are common rules of thumb, not personal advice. Hover a metric for how it's calculated." action={<Link href="/reports" className="text-xs text-accent">Details</Link>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {sc.metrics.map((m) => (
            <div key={m.key} className="rounded-lg bg-surface-2 p-3" title={m.explain}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted">{m.label}</span>
                <Badge tone={statusTone[m.status]}>{statusWord[m.status]}</Badge>
              </div>
              <div className="mt-1 text-xl font-semibold num">{m.display}</div>
              <div className="text-[11px] text-muted">Target: {m.benchmark}</div>
            </div>
          ))}
        </div>
        {sc.monthsOfHistory < 2 && (
          <p className="mt-3 text-xs text-muted">Spending ratios appear after two full months of history ({sc.monthsOfHistory} so far). Import older statements to see them sooner.</p>
        )}
        {!sc.savingsRateIsTrue && sc.monthsOfHistory >= 2 && (
          <p className="mt-3 text-xs text-muted">
            Savings rate is estimated from bank deposits only. <Link className="text-accent underline" href="/settings/income">Add paychecks</Link> to include pre-tax 401(k), HSA, and employer match.
          </p>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Net worth, 12 months" action={<Link href="/net-worth" className="text-xs text-accent">Breakdown</Link>}>
          <LineChart
            series={[
              { name: "Net worth", values: nw.map((p) => p.netWorth), color: "var(--chart-1)" },
              { name: "Assets", values: nw.map((p) => p.assets), color: "var(--chart-2)", dashed: true },
            ]}
            labels={nw.map((p) => new Date(p.month + "-15").toLocaleDateString("en-US", { month: "short" }))}
          />
        </Card>
        <Card title="Next 14 days" action={<Link href="/forecast" className="text-xs text-accent">Forecast</Link>}>
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted">No recurring bills detected yet. They'll appear after a couple of months of history.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {upcoming.map(({ date, s }) => (
                <li key={s.key + date} className="flex justify-between py-1.5">
                  <span>
                    <span className="text-muted num">{date.slice(5).replace("-", "/")}</span> {s.label}
                  </span>
                  <Money cents={-s.typicalAmount} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Sinking funds" action={<Link href="/budget#funds" className="text-xs text-accent">Manage</Link>}>
          {mb.statuses.length === 0 ? (
            <p className="text-sm text-muted">Set aside monthly for annual bills (insurance, holidays, car repairs) so they never wreck a month.</p>
          ) : (
            <ul className="space-y-2.5 text-sm">
              {mb.statuses.slice(0, 5).map((f) => (
                <li key={f.fund.id}>
                  <div className="flex justify-between">
                    <span>{f.fund.name}</span>
                    <span className="num text-muted">{formatCents(f.balance, { noCents: true })} / {formatCents(f.fund.target, { noCents: true })}</span>
                  </div>
                  <Progress value={f.balance} max={f.fund.target} tone={f.status === "behind" || f.status === "overdrawn" ? "warn" : "good"} />
                </li>
              ))}
            </ul>
          )}
          {behindFunds.length > 0 && <p className="mt-2 text-xs text-warn">{behindFunds.length} fund{behindFunds.length > 1 ? "s" : ""} behind schedule.</p>}
        </Card>
        <Card title="Between you two" action={<Link href="/couple" className="text-xs text-accent">Details</Link>}>
          {couple.policy.fullyJoint ? (
            <p className="text-sm">Fully joint. No settle-up needed.</p>
          ) : (
            <>
              <div className="text-sm">
                {couple.all.balance === 0 ? (
                  "All square."
                ) : (
                  <>
                    <strong>{couple.all.balance > 0 ? couple.names.B : couple.names.A}</strong> owes <strong>{couple.all.balance > 0 ? couple.names.A : couple.names.B}</strong>{" "}
                    <Money cents={Math.abs(couple.all.balance)} className="font-semibold" />
                  </>
                )}
              </div>
              <div className="mt-3 text-xs text-muted">Spending through joint accounts this month</div>
              <div className="text-xl font-semibold num">{pct(couple.jointTrend.at(-1)?.share ?? 0)}</div>
            </>
          )}
        </Card>
        <Card title="Recent activity" action={<Link href="/transactions" className="text-xs text-accent">All</Link>}>
          {mb.ledger.txns.length === 0 ? (
            <Empty title="No transactions yet" />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {mb.ledger.txns
                .filter((t) => t.date <= ctx.today && !(t.isPrivate && t.owner !== ctx.viewer))
                .slice(0, 7)
                .map((t) => (
                  <li key={t.id} className="flex justify-between gap-2 py-1.5">
                    <span className="truncate">{t.merchant ?? t.payeeRaw}</span>
                    <Money cents={t.amount} colored={t.amount > 0} />
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
