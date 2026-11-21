import { getContext } from "@/server/context";
import { loadCategories, toCategory } from "@/server/repo";
import { loadRules } from "@/server/ingest";
import { getDb } from "@/db";
import { createRule, toggleRule, deleteRule } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { CategoryOptions } from "@/components/CategorySelect";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { formatCents } from "@/domain/money";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const ctx = await getContext();
  const categories = loadCategories(ctx.householdId).map(toCategory);
  const cats = new Map(categories.map((c) => [c.id, c.name]));
  const rules = loadRules(ctx.householdId, getDb()).sort((a, b) => a.priority - b.priority);
  const describe = (r: (typeof rules)[number]) => {
    const c = r.conditions;
    const parts = [
      c.merchantEquals && `merchant is "${c.merchantEquals}"`,
      c.payeeContains && `description contains "${c.payeeContains}"`,
      c.payeeRegex && `description matches /${c.payeeRegex}/`,
      c.amountMin != null && `amount ≥ ${formatCents(c.amountMin)}`,
      c.amountMax != null && `amount ≤ ${formatCents(c.amountMax)}`,
      c.direction && `money ${c.direction === "outflow" ? "out" : "in"}`,
    ].filter(Boolean);
    const a = r.actions;
    const acts = [
      a.setCategoryId && `category → ${cats.get(a.setCategoryId) ?? "?"}`,
      a.setMerchant && `rename → ${a.setMerchant}`,
      a.setOwner && `owner → ${a.setOwner === "A" ? ctx.names.A : a.setOwner === "B" ? ctx.names.B : "Joint"}`,
      a.setShared && "mark shared",
      a.markReimbursable && "reimbursable",
      a.hide && "hide",
      a.addTags?.length && `tags ${a.addTags.map((t) => "#" + t).join(" ")}`,
    ].filter(Boolean);
    return { when: parts.join(" and "), then: acts.join(", ") };
  };
  return (
    <>
      <PageHeader title="Rules" subtitle="Lower priority numbers run first; for each field, the first matching rule wins. Your rules run before the starter rules." />
      <Card className="mb-4" title="New rule">
        <ActionForm action={createRule} className="grid gap-3 sm:grid-cols-4" resetOnSuccess>
          <Field label="Match on"><select name="matchField" defaultValue="contains"><option value="contains">Description contains</option><option value="merchant">Merchant is</option><option value="regex">Regex</option></select></Field>
          <Field label="Text"><input name="matchValue" required /></Field>
          <Field label="Min amount"><input name="amountMin" inputMode="decimal" /></Field>
          <Field label="Max amount"><input name="amountMax" inputMode="decimal" /></Field>
          <Field label="Direction"><select name="direction"><option value="">Any</option><option value="outflow">Money out</option><option value="inflow">Money in</option></select></Field>
          <Field label="Set category"><select name="categoryId"><CategoryOptions categories={categories} /></select></Field>
          <Field label="Rename to"><input name="rename" /></Field>
          <Field label="Set owner"><select name="owner"><option value="">—</option><option value="A">{ctx.names.A}</option><option value="B">{ctx.names.B}</option><option value="joint">Joint</option></select></Field>
          <Field label="Add tags"><input name="tags" placeholder="charitable, business" /></Field>
          <Field label="Priority"><input name="priority" type="number" defaultValue={100} /></Field>
          <div className="flex flex-col justify-end gap-1 sm:col-span-2">
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="shared" /> Shared</label>
              <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="reimbursable" /> Reimbursable</label>
              <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="hide" /> Hide</label>
              <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="applyPast" /> Apply to past (open months, skips your manual edits)</label>
            </div>
          </div>
          <div className="sm:col-span-4"><Submit>Create rule</Submit></div>
        </ActionForm>
      </Card>
      <Card title={`${rules.length} rules`}>
        <ul className="divide-y divide-line">
          {rules.map((r) => {
            const d = describe(r);
            return (
              <li key={r.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${r.enabled ? "" : "opacity-50"}`}>
                <div className="min-w-0 text-sm">
                  <div className="font-medium">{r.name} <Badge>#{r.priority}</Badge></div>
                  <div className="text-xs text-muted">When {d.when} → {d.then}</div>
                </div>
                <div className="flex gap-2">
                  <form action={toggleRule}><input type="hidden" name="id" value={r.id} /><button className="text-xs text-accent underline">{r.enabled ? "Disable" : "Enable"}</button></form>
                  <form action={deleteRule}><input type="hidden" name="id" value={r.id} /><button className="text-xs text-bad underline">Delete</button></form>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
