import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { getDb, schema } from "@/db";
import { loadCategories, loadSplits, ownerLabel, toCategory } from "@/server/repo";
import { createRule, saveSplits, unlinkTransferAction, updateTxn } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { CategoryOptions } from "@/components/CategorySelect";
import { Badge, Card, Field, Money, PageHeader, dollarsInput } from "@/components/ui";
import { TAX_TAGS } from "@/domain/tax";
import { ACCOUNT_TYPE_LABELS } from "@/domain/accounts";
import type { AccountType } from "@/domain/types";

export const dynamic = "force-dynamic";

export default async function TxnDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  const db = getDb();
  const t = db.select().from(schema.transactions).where(and(eq(schema.transactions.id, id), eq(schema.transactions.householdId, ctx.householdId))).get();
  if (!t) notFound();
  const acct = db.select().from(schema.accounts).where(eq(schema.accounts.id, t.accountId)).get()!;
  const categories = loadCategories(ctx.householdId).map((c) => ({ ...toCategory(c), archived: c.archived }));
  const isOthersPrivate = (t.isPrivate || categories.find((c) => c.id === t.categoryId)?.isPersonalAllowance) && (t.owner ?? acct.owner) !== ctx.viewer && (t.owner ?? acct.owner) !== "joint";
  if (isOthersPrivate) {
    return (
      <>
        <PageHeader title="Personal spending" />
        <Card>
          <p className="text-sm text-muted">This is part of your partner's personal fun money. Only the total is shared.</p>
        </Card>
      </>
    );
  }
  const splits = loadSplits([t.id]).get(t.id) ?? [];
  const pair = t.transferPairId ? db.select().from(schema.transactions).where(eq(schema.transactions.id, t.transferPairId)).get() : null;
  const pairAcct = pair ? db.select().from(schema.accounts).where(eq(schema.accounts.id, pair.accountId)).get() : null;
  const closed = db.select().from(schema.monthCloses).where(and(eq(schema.monthCloses.householdId, ctx.householdId), eq(schema.monthCloses.month, t.date.slice(0, 7)))).get();
  const audit = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.householdId, ctx.householdId), eq(schema.auditLog.entityId, t.id))).all();
  const users = new Map(db.select().from(schema.users).where(eq(schema.users.householdId, ctx.householdId)).all().map((u) => [u.id, u.name]));
  const blankRows = Math.max(2, 4 - splits.length);

  return (
    <>
      <PageHeader
        title={t.merchant ?? t.payeeRaw}
        subtitle={
          <span>
            <Money cents={t.amount} className={t.amount > 0 ? "text-good" : ""} /> · {t.date} · {acct.name} ({ACCOUNT_TYPE_LABELS[acct.type as AccountType]})
          </span>
        }
        actions={<Link href="/transactions" className="text-sm text-accent">← Transactions</Link>}
      />
      {closed && <div className="mb-4 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">{t.date.slice(0, 7)} is closed. Reopen it on the Monthly close page to make changes.</div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Details">
          <ActionForm action={updateTxn} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="id" value={t.id} />
            <Field label="Merchant (display name)">
              <input name="merchant" defaultValue={t.merchant ?? ""} />
            </Field>
            <Field label="Category" hint={t.categorySource && t.categorySource !== "user" ? `Set automatically by ${t.categorySource}` : undefined}>
              <select name="categoryId" defaultValue={t.categoryId ?? ""} disabled={splits.length > 0}>
                <CategoryOptions categories={categories} />
              </select>
            </Field>
            <Field label="Whose is this?" hint={`Defaults to the account owner (${ownerLabel(acct.owner as "A" | "B" | "joint", ctx.names)}).`}>
              <select name="owner" defaultValue={t.owner ?? ""}>
                <option value="">Same as account</option>
                <option value="A">{ctx.names.A}</option>
                <option value="B">{ctx.names.B}</option>
                <option value="joint">Joint</option>
              </select>
            </Field>
            <Field label="Tags" hint={`Comma separated. Tax tags: ${TAX_TAGS.map((x) => x.key).join(", ")}`}>
              <input name="tags" defaultValue={(t.tags ?? []).join(", ")} />
            </Field>
            <div className="space-y-2 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="isShared" defaultChecked={t.isShared} /> Shared household expense paid from a personal account (counts toward settle-up)
              </label>
              <label className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="isReimbursable" defaultChecked={t.isReimbursable} /> Reimbursable (work expense or fronted for someone; excluded from budgets)
              </label>
              <label className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="isSettlement" defaultChecked={t.isSettlement} /> Settle-up payment between us
              </label>
              <label className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="isPrivate" defaultChecked={t.isPrivate} /> Private (personal fun money: partner sees only totals)
              </label>
              <label className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="isHidden" defaultChecked={t.isHidden} /> Hide from all reports
              </label>
            </div>
            <div className="sm:col-span-2">
              <Field label="Notes">
                <textarea name="notes" rows={2} defaultValue={t.notes ?? ""} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Submit>Save</Submit>
            </div>
          </ActionForm>
        </Card>

        <div className="space-y-4">
          <Card title="Bank record">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-muted">Description</dt><dd className="text-right break-all">{t.payeeRaw}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Source</dt><dd>{t.source}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Status</dt><dd>{t.pending ? <Badge tone="warn">Pending</Badge> : "Posted"}</dd></div>
              {t.reviewedBy && <div className="flex justify-between"><dt className="text-muted">Reviewed by</dt><dd>{users.get(t.reviewedBy) ?? "—"}</dd></div>}
            </dl>
          </Card>
          {pair && (
            <Card title="Transfer">
              <p className="text-sm">
                Linked to <Link className="text-accent underline" href={`/transactions/${pair.id}`}>{pairAcct?.name}</Link> on {pair.date}. Excluded from spending and income
                {pairAcct && ["savings", "brokerage", "retirement_401k", "ira", "roth_ira", "hsa", "cd", "education_529"].includes(pairAcct.type) ? "; counted as savings." : "."}
              </p>
              <form action={unlinkTransferAction} className="mt-2">
                <input type="hidden" name="id" value={t.id} />
                <button className="text-xs text-bad underline">Unlink (not a transfer)</button>
              </form>
            </Card>
          )}
          {audit.length > 0 && (
            <Card title="History">
              <ul className="space-y-1 text-xs text-muted">
                {audit.map((a) => (
                  <li key={a.id}>
                    {a.at.slice(0, 16)} · {a.userId ? users.get(a.userId) : "system"} · {a.action.replace("txn.", "")}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <Card className="mt-4" title="Split" subtitle="Divide one purchase across categories or people (e.g. a Target run that's groceries + household + a gift). Lines must add up to the total.">
        <ActionForm action={saveSplits} className="space-y-2">
          <input type="hidden" name="id" value={t.id} />
          {[...splits.map((s) => ({ amount: Math.abs(s.amount), categoryId: s.categoryId, owner: s.owner })), ...Array.from({ length: blankRows }, () => ({ amount: null as number | null, categoryId: null as string | null, owner: null as string | null }))].map((s, i) => (
            <div key={i} className="grid grid-cols-[7rem_1fr_9rem] gap-2">
              <input name="splitAmount" inputMode="decimal" placeholder="0.00" defaultValue={dollarsInput(s.amount)} aria-label="Amount" />
              <select name="splitCategory" defaultValue={s.categoryId ?? ""} aria-label="Category">
                <CategoryOptions categories={categories} />
              </select>
              <select name="splitOwner" defaultValue={s.owner ?? ""} aria-label="Owner">
                <option value="">Same as txn</option>
                <option value="A">{ctx.names.A}</option>
                <option value="B">{ctx.names.B}</option>
                <option value="joint">Joint</option>
              </select>
            </div>
          ))}
          <p className="text-xs text-muted">Total to allocate: <Money cents={Math.abs(t.amount)} />. Clear every line to remove the split.</p>
          <Submit variant="secondary">Save split</Submit>
        </ActionForm>
      </Card>

      <Card className="mt-4" title="Make a rule" subtitle="Apply this categorization automatically to future transactions from this merchant.">
        <ActionForm action={createRule} className="grid gap-3 sm:grid-cols-4">
          <input type="hidden" name="matchField" value="merchant" />
          <Field label="When merchant is">
            <input name="matchValue" defaultValue={t.merchant ?? ""} />
          </Field>
          <Field label="Set category">
            <select name="categoryId" defaultValue={t.categoryId ?? ""}>
              <CategoryOptions categories={categories} />
            </select>
          </Field>
          <Field label="Set owner">
            <select name="owner" defaultValue="">
              <option value="">Don't change</option>
              <option value="A">{ctx.names.A}</option>
              <option value="B">{ctx.names.B}</option>
              <option value="joint">Joint</option>
            </select>
          </Field>
          <div className="flex flex-col justify-end gap-1.5">
            <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="shared" /> Mark shared</label>
            <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="applyPast" defaultChecked /> Apply to past (open months)</label>
          </div>
          <div className="sm:col-span-4">
            <Submit variant="secondary">Create rule</Submit>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
