import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/server/auth";
import { loadLedger, ownerLabel, getHousehold } from "@/server/repo";
import { audit } from "@/server/audit";

export const dynamic = "force-dynamic";

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Neutralize spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function GET(req: Request) {
  const u = await getSessionUser();
  if (!u || (u.totpEnabled && !u.mfaPassed)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "csv";
  const year = url.searchParams.get("year");
  const hh = getHousehold(u.householdId);
  audit(u.householdId, u.id, "data.export", undefined, undefined, { format, year });

  if (format === "json") {
    const db = getDb();
    const hid = u.householdId;
    const dump = {
      exportedAt: new Date().toISOString(),
      household: hh,
      accounts: db.select().from(schema.accounts).where(eq(schema.accounts.householdId, hid)).all(),
      transactions: db.select().from(schema.transactions).where(eq(schema.transactions.householdId, hid)).all(),
      categories: db.select().from(schema.categories).where(eq(schema.categories.householdId, hid)).all(),
      rules: db.select().from(schema.rules).where(eq(schema.rules.householdId, hid)).all(),
      budgets: db.select().from(schema.budgetMonths).where(eq(schema.budgetMonths.householdId, hid)).all(),
      sinkingFunds: db.select().from(schema.sinkingFunds).where(eq(schema.sinkingFunds.householdId, hid)).all(),
      goals: db.select().from(schema.goals).where(eq(schema.goals.householdId, hid)).all(),
      paychecks: db.select().from(schema.paychecks).where(eq(schema.paychecks.householdId, hid)).all(),
      settlements: db.select().from(schema.settlements).where(eq(schema.settlements.householdId, hid)).all(),
      snapshots: db.select().from(schema.balanceSnapshots).all(),
    };
    // Never export secrets.
    const safe = JSON.stringify(dump, (k, v) => (k === "accessUrlEnc" || k === "passwordHash" || k === "totpSecret" ? undefined : v), 2);
    return new Response(safe, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="hearth-export-${new Date().toISOString().slice(0, 10)}.json"` } });
  }

  const ledger = loadLedger(u.householdId, year ? { start: `${year}-01-01`, end: `${year}-12-31` } : {});
  const accts = new Map(ledger.accounts.map((a) => [a.id, a.name]));
  const cats = new Map(ledger.categories.map((c) => [c.id, c]));
  const txns = new Map(ledger.txns.map((t) => [t.id, t]));
  const viewer = u.slot as "A" | "B";
  const lines = ledger.lines.filter((l) => !(l.isPrivate && l.owner !== viewer && l.owner !== "joint"));
  const rows =
    format === "tax"
      ? [["Date", "Tag", "Merchant", "Category", "Amount", "Owner", "Notes"], ...lines.flatMap((l) => l.tags.map((tag) => [l.date, tag, txns.get(l.txnId)?.merchant ?? txns.get(l.txnId)?.payeeRaw, l.categoryId ? cats.get(l.categoryId)?.name : "", (-l.amount / 100).toFixed(2), ownerLabel(l.owner, hh.names), txns.get(l.txnId)?.notes ?? ""]))]
      : [
          ["Date", "Account", "Merchant", "Description", "Category", "Group", "Flow", "Amount", "Owner", "Shared", "Pending", "Tags", "Notes"],
          ...lines.map((l) => {
            const t = txns.get(l.txnId)!;
            const c = l.categoryId ? cats.get(l.categoryId) : undefined;
            return [l.date, accts.get(l.accountId), t.merchant, t.payeeRaw, c?.name ?? "", c?.group ?? "", l.kind, (l.amount / 100).toFixed(2), ownerLabel(l.owner, hh.names), l.isShared ? "yes" : "", l.pending ? "yes" : "", l.tags.join(" "), t.notes ?? ""];
          }),
        ];
  const body = rows.map((r) => r.map(csvCell).join(",")).join("\n");
  return new Response(body, { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="hearth-${format}-${year ?? "all"}.csv"` } });
}
