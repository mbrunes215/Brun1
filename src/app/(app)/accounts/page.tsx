import Link from "next/link";
import { getContext } from "@/server/context";
import { loadAccounts, ownerLabel, toAccount } from "@/server/repo";
import { ACCOUNT_TYPE_LABELS, isLiability } from "@/domain/accounts";
import { netWorth } from "@/domain/networth";
import { Badge, Card, Empty, LinkButton, Money, PageHeader } from "@/components/ui";
import type { AccountType } from "@/domain/types";

export const dynamic = "force-dynamic";

const GROUPS: Array<[string, AccountType[]]> = [
  ["Cash", ["checking", "savings", "cd"]],
  ["Credit cards", ["credit_card"]],
  ["Investments", ["brokerage", "crypto"]],
  ["Retirement & HSA", ["retirement_401k", "ira", "roth_ira", "hsa", "education_529"]],
  ["Property", ["real_estate", "vehicle", "other_asset"]],
  ["Loans", ["mortgage", "heloc", "auto_loan", "student_loan", "personal_loan", "other_liability"]],
];

export default async function AccountsPage() {
  const ctx = await getContext();
  const rows = loadAccounts(ctx.householdId);
  const visible = rows.filter((a) => !a.isHidden && (ctx.view === "household" || a.owner === ctx.view));
  const nw = netWorth(visible.map(toAccount));
  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle={<>Net worth <Money cents={nw.netWorth} className="font-semibold text-fg" /> · Assets <Money cents={nw.assets} /> · Debts <Money cents={-nw.liabilities} /></>}
        actions={
          <>
            <LinkButton href="/settings/connections">Bank connections</LinkButton>
            <LinkButton href="/accounts/new" variant="primary">Add account</LinkButton>
          </>
        }
      />
      {visible.length === 0 ? (
        <Empty title="No accounts yet">Connect SimpleFIN or add a manual account.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {GROUPS.map(([label, types]) => {
            const accts = visible.filter((a) => types.includes(a.type as AccountType));
            if (!accts.length) return null;
            const total = accts.reduce((s, a) => s + a.balance, 0);
            return (
              <Card key={label} title={label} action={<Money cents={total} className="text-sm font-semibold" />}>
                <ul className="divide-y divide-line">
                  {accts.map((a) => {
                    const util = a.type === "credit_card" && a.creditLimit ? Math.max(0, -a.balance) / a.creditLimit : null;
                    return (
                      <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <Link href={`/accounts/${a.id}`} className="text-sm font-medium hover:underline">{a.name}</Link>
                          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                            <span>{ACCOUNT_TYPE_LABELS[a.type as AccountType]}</span>
                            <Badge>{ownerLabel(a.owner as "A" | "B" | "joint", ctx.names)}</Badge>
                            {a.isManual ? <Badge>Manual</Badge> : <Badge tone="info">Synced</Badge>}
                            {a.apr != null && <span>{(a.apr * 100).toFixed(2)}% APR</span>}
                            {util != null && <Badge tone={util > 0.3 ? "bad" : util > 0.1 ? "warn" : "good"}>{Math.round(util * 100)}% used</Badge>}
                            {a.isManual && a.balanceDate && <span>updated {a.balanceDate}</span>}
                          </div>
                        </div>
                        <Money cents={a.balance} className={`text-sm ${isLiability(toAccount(a)) ? "text-bad" : ""}`} />
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
