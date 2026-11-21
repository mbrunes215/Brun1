import { getContext } from "@/server/context";
import { loadCategories } from "@/server/repo";
import { saveCategory, archiveCategory } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { CATEGORY_GROUP_ORDER } from "@/domain/categories";

export const dynamic = "force-dynamic";

const BT: Record<string, string> = { fixed: "Fixed", flex: "Flex", non_monthly: "Non-monthly (sinking fund)", income: "Income", savings: "Savings", transfer: "Transfer" };

export default async function CategoriesPage() {
  const ctx = await getContext();
  const cats = loadCategories(ctx.householdId).filter((c) => !c.archived);
  const groups = [...new Set([...CATEGORY_GROUP_ORDER, ...cats.map((c) => c.group)])];
  return (
    <>
      <PageHeader title="Categories" subtitle="Budget type decides where spending lands in the plan. Essential categories size your emergency fund." />
      <Card className="mb-4" title="Add category">
        <ActionForm action={saveCategory} className="grid gap-3 sm:grid-cols-5" resetOnSuccess>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Group"><input name="group" list="groups" required /><datalist id="groups">{groups.map((g) => <option key={g} value={g} />)}</datalist></Field>
          <Field label="Budget type"><select name="budgetType" defaultValue="flex">{Object.entries(BT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <div className="flex flex-col justify-end gap-1">
            <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="essential" /> Essential</label>
            <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="isPersonalAllowance" /> Private fun money</label>
          </div>
          <div className="flex items-end"><Submit>Add</Submit></div>
        </ActionForm>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.filter((g) => cats.some((c) => c.group === g)).map((g) => (
          <Card key={g} title={g}>
            <ul className="divide-y divide-line">
              {cats.filter((c) => c.group === g).map((c) => (
                <li key={c.id} className="py-2">
                  <details>
                    <summary className="flex cursor-pointer items-center justify-between text-sm">
                      <span>{c.name}</span>
                      <span className="flex gap-1">
                        <Badge tone={c.budgetType === "fixed" ? "info" : c.budgetType === "non_monthly" ? "warn" : c.budgetType === "flex" ? "accent" : "neutral"}>{BT[c.budgetType]?.split(" ")[0]}</Badge>
                        {c.essential && <Badge tone="good">Essential</Badge>}
                        {c.isPersonalAllowance && <Badge>Private</Badge>}
                      </span>
                    </summary>
                    <ActionForm action={saveCategory} className="mt-2 grid gap-2 sm:grid-cols-3">
                      <input type="hidden" name="id" value={c.id} />
                      <input name="name" defaultValue={c.name} aria-label="Name" />
                      <input name="group" defaultValue={c.group} aria-label="Group" />
                      <select name="budgetType" defaultValue={c.budgetType} aria-label="Budget type">{Object.entries(BT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                      <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="essential" defaultChecked={c.essential} /> Essential</label>
                      <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" name="isPersonalAllowance" defaultChecked={c.isPersonalAllowance} /> Private</label>
                      <div className="flex gap-2"><Submit variant="secondary">Save</Submit><button formAction={archiveCategory} className="text-xs text-bad">Archive</button></div>
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
