import Link from "next/link";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { loadAccounts, loadCategories, loadTxnRows, loadSplits, ownerLabel, toAccount, toCategory, toTxn } from "@/server/repo";
import { classifyAll, makeContext, summarize } from "@/domain/ledger";
import { setTxnCategory, markReviewed, markAllReviewedBefore, confirmTransferSuggestion, rejectTransferSuggestion, resolveDuplicate, addManualTxn } from "@/server/actions";
import { Badge, Card, Empty, Field, LinkButton, Money, PageHeader } from "@/components/ui";
import { AutoSubmit, ActionForm, Submit } from "@/components/ActionForm";
import { CategoryOptions } from "@/components/CategorySelect";
import { addMonths, formatCents, monthEnd, monthStart } from "@/domain/money";

export const dynamic = "force-dynamic";

const FILTERS = [
  ["all", "All"],
  ["unreviewed", "To review"],
  ["uncategorized", "Uncategorized"],
  ["shared", "Shared expenses"],
  ["transfers", "Transfer suggestions"],
  ["duplicates", "Possible duplicates"],
  ["reimbursable", "Awaiting reimbursement"],
] as const;

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const month = sp.month ?? ctx.today.slice(0, 7);
  const filter = sp.filter ?? "all";
  const q = (sp.q ?? "").toLowerCase();
  const allTime = filter !== "all" || !!q;
  const accounts = loadAccounts(ctx.householdId);
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const catRows = loadCategories(ctx.householdId);
  const categories = catRows.map((c) => ({ ...toCategory(c), archived: c.archived }));
  const catById = new Map(categories.map((c) => [c.id, c]));
  let rows = loadTxnRows(ctx.householdId, allTime ? {} : { start: monthStart(month), end: monthEnd(month), accountId: sp.account });
  if (sp.account) rows = rows.filter((r) => r.accountId === sp.account);
  if (sp.category) rows = rows.filter((r) => r.categoryId === sp.category);
  if (q) rows = rows.filter((r) => (r.merchant ?? "").toLowerCase().includes(q) || r.payeeRaw.toLowerCase().includes(q) || (r.notes ?? "").toLowerCase().includes(q) || formatCents(Math.abs(r.amount)).includes(q));
  const effOwner = (r: (typeof rows)[number]) => r.owner ?? acctById.get(r.accountId)?.owner ?? "joint";
  if (ctx.view !== "household") rows = rows.filter((r) => effOwner(r) === ctx.view);
  switch (filter) {
    case "unreviewed":
      rows = rows.filter((r) => !r.reviewedAt && !r.isHidden);
      break;
    case "uncategorized":
      rows = rows.filter((r) => !r.categoryId && !r.isTransfer && !r.isHidden);
      break;
    case "shared":
      rows = rows.filter((r) => r.isShared);
      break;
    case "transfers":
      rows = rows.filter((r) => r.transferSuggestedPairId && r.transferSuggestedPairId !== "rejected" && r.amount < 0);
      break;
    case "duplicates":
      rows = rows.filter((r) => r.possibleDuplicateOf);
      break;
    case "reimbursable":
      rows = rows.filter((r) => r.isReimbursable && !r.reimbursementOfId);
      break;
  }
  // Fun-money privacy: the partner sees only a total.
  const hidden = rows.filter((r) => r.isPrivate || (r.categoryId && catById.get(r.categoryId)?.isPersonalAllowance));
  const privateOther = hidden.filter((r) => effOwner(r) !== ctx.viewer && effOwner(r) !== "joint");
  const privateIds = new Set(privateOther.map((r) => r.id));
  const visible = rows.filter((r) => !privateIds.has(r.id)).slice(0, 500);
  const splits = loadSplits(visible.map((r) => r.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pairRows = filter === "transfers" ? getDb().select().from(schema.transactions).where(eq(schema.transactions.householdId, ctx.householdId)).all() : [];
  const pairById = new Map(pairRows.map((r) => [r.id, r]));
  // Totals use the accounting engine so transfers, card payments, and retirement contributions aren't counted as income or spending.
  const visTxns = visible.map((r) => toTxn(r, splits.get(r.id)));
  const flow = summarize(classifyAll(visTxns, makeContext(accounts.map(toAccount), categories, visTxns)));

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { month, filter, q: sp.q, account: sp.account, category: sp.category, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/transactions?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle={allTime ? "Showing all dates" : new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        actions={
          <>
            {!allTime && (
              <>
                <LinkButton href={qs({ month: addMonths(month, -1) })}>← Prev</LinkButton>
                <LinkButton href={qs({ month: addMonths(month, 1) })}>Next →</LinkButton>
              </>
            )}
            <LinkButton href="/import">Import</LinkButton>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map(([k, label]) => (
          <Link key={k} href={qs({ filter: k === "all" ? undefined : k })} className={`rounded-full border px-3 py-1 text-xs ${filter === k ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-fg"}`}>
            {label}
          </Link>
        ))}
      </div>

      <form className="mb-4 grid gap-2 sm:grid-cols-4" action="/transactions">
        <input type="hidden" name="month" value={month} />
        {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
        <input name="q" placeholder="Search merchant, notes, amount" defaultValue={sp.q} className="sm:col-span-2" />
        <select name="account" defaultValue={sp.account ?? ""}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <select name="category" defaultValue={sp.category ?? ""}>
            <option value="">All categories</option>
            <CategoryOptions categories={categories} includeNone={false} />
          </select>
          <button className="rounded-lg border border-line px-3 text-sm hover:bg-surface-2">Go</button>
        </div>
      </form>

      {filter === "unreviewed" && visible.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>Review is how you both stay on the same page. Tip: each of you reviews your own accounts.</span>
          <form action={markAllReviewedBefore}>
            <input type="hidden" name="date" value={ctx.today} />
            <button className="text-accent underline">Mark all as reviewed</button>
          </form>
        </div>
      )}

      <div className="mb-2 flex justify-between text-xs text-muted num">
        <span>{visible.length} transactions</span>
        <span>
          Income <Money cents={flow.income} /> · Spending <Money cents={flow.spending} />{flow.saved ? <> · Saved <Money cents={flow.saved} /></> : null}
        </span>
      </div>

      {visible.length === 0 ? (
        <Empty title="Nothing here">
          {filter === "unreviewed" ? "You're all caught up." : "Try another month or filter, or import transactions."}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <ul className="divide-y divide-line">
            {visible.map((r) => {
              const acct = acctById.get(r.accountId);
              const sp2 = splits.get(r.id);
              const pair = r.transferSuggestedPairId ? pairById.get(r.transferSuggestedPairId) : undefined;
              const dupOf = r.possibleDuplicateOf ? byId.get(r.possibleDuplicateOf) : undefined;
              return (
                <li key={r.id} className={`grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[5.5rem_1fr_13rem_7rem] sm:items-center ${r.pending ? "opacity-70" : ""}`}>
                  <div className="hidden text-xs text-muted num sm:block">{r.date.slice(5).replace("-", "/")}</div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {!r.reviewedAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Not reviewed" />}
                      <Link href={`/transactions/${r.id}`} className="truncate text-sm font-medium hover:underline">
                        {r.merchant ?? r.payeeRaw}
                      </Link>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                      <span className="sm:hidden num">{r.date.slice(5).replace("-", "/")} ·</span>
                      <span className="truncate">{acct?.name}</span>
                      {effOwner(r) !== "joint" && <Badge>{ownerLabel(effOwner(r), ctx.names)}</Badge>}
                      {r.pending && <Badge tone="warn">Pending</Badge>}
                      {r.isTransfer && <Badge tone="info">Transfer</Badge>}
                      {r.isShared && <Badge tone="accent">Shared</Badge>}
                      {r.isReimbursable && <Badge tone="warn">Reimbursable</Badge>}
                      {r.isSettlement && <Badge tone="info">Settle-up</Badge>}
                      {r.isHidden && <Badge>Hidden</Badge>}
                      {sp2 && <Badge tone="info">Split ×{sp2.length}</Badge>}
                      {(r.tags ?? []).map((t) => (
                        <Badge key={t}>#{t}</Badge>
                      ))}
                    </div>
                    {pair && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted">
                          Looks like a transfer to {acctById.get(pair.accountId)?.name} on {pair.date}.
                        </span>
                        <form action={confirmTransferSuggestion}>
                          <input type="hidden" name="id" value={r.id} />
                          <button className="text-accent underline">Link</button>
                        </form>
                        <form action={rejectTransferSuggestion}>
                          <input type="hidden" name="id" value={r.id} />
                          <button className="text-muted underline">Not a transfer</button>
                        </form>
                      </div>
                    )}
                    {r.possibleDuplicateOf && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-warn">Possible duplicate of {dupOf ? `${dupOf.merchant ?? dupOf.payeeRaw} on ${dupOf.date}` : "another transaction"}.</span>
                        <form action={resolveDuplicate}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="decision" value="delete" />
                          <button className="text-bad underline">Delete this one</button>
                        </form>
                        <form action={resolveDuplicate}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="decision" value="keep" />
                          <button className="text-muted underline">Keep both</button>
                        </form>
                      </div>
                    )}
                  </div>
                  <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
                    {sp2 ? (
                      <Link href={`/transactions/${r.id}`} className="text-xs text-muted underline">
                        {sp2.map((s) => (s.categoryId ? catById.get(s.categoryId)?.name : "Uncategorized")).join(", ")}
                      </Link>
                    ) : (
                      <AutoSubmit action={setTxnCategory}>
                        <input type="hidden" name="id" value={r.id} />
                        <select name="categoryId" defaultValue={r.categoryId ?? ""} aria-label="Category" className={`!py-1 text-xs ${!r.categoryId && !r.isTransfer ? "!border-warn" : ""}`}>
                          <CategoryOptions categories={categories} />
                        </select>
                      </AutoSubmit>
                    )}
                  </div>
                  <div className="row-start-1 text-right sm:row-start-auto">
                    <Money cents={r.amount} className={`text-sm font-medium ${r.amount > 0 ? "text-good" : ""}`} />
                    {!r.reviewedAt && (
                      <form action={markReviewed}>
                        <input type="hidden" name="ids" value={r.id} />
                        <button className="text-[11px] text-accent hover:underline">Mark reviewed</button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {privateOther.length > 0 && (
        <p className="mt-3 text-xs text-muted">
          Plus {privateOther.length} personal fun-money transaction{privateOther.length > 1 ? "s" : ""} by your partner totaling{" "}
          <Money cents={-privateOther.reduce((s, r) => s + r.amount, 0)} />. Line items are private by design.
        </p>
      )}

      <Card className="mt-6" title="Add a cash transaction" subtitle="For cash spending or anything your bank doesn't report.">
        <ActionForm action={addManualTxn} className="grid gap-3 sm:grid-cols-6" resetOnSuccess>
          <Field label="Account">
            <select name="accountId" required>
              {accounts.filter((a) => ["checking", "credit_card", "savings"].includes(a.type)).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" name="date" defaultValue={ctx.today} required />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Payee">
              <input name="payee" required />
            </Field>
          </div>
          <Field label="Amount">
            <input name="amount" inputMode="decimal" required />
          </Field>
          <Field label="Direction">
            <select name="direction">
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
          </Field>
          <div className="sm:col-span-6">
            <Submit>Add</Submit>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
