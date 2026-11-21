import { getContext } from "@/server/context";
import { loadPaychecks } from "@/server/insights";
import { loadAccounts } from "@/server/repo";
import { savePaycheck, deletePaycheck } from "@/server/actions";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Card, Field, Money, PageHeader, Stat, dollarsInput, pct } from "@/components/ui";
import { computedNet, monthly, monthlyIncomeModel, type Paycheck } from "@/domain/income";
import { formatCents } from "@/domain/money";

export const dynamic = "force-dynamic";

const KINDS = [
  ["retirement_pretax", "401(k)/403(b) pre-tax"],
  ["hsa", "HSA"],
  ["fsa", "FSA"],
  ["health", "Health/dental/vision premium"],
  ["roth_retirement", "Roth 401(k)"],
  ["espp", "ESPP"],
  ["other", "Other"],
];

function PaycheckForm({ p, names, accounts }: { p?: Paycheck; names: { A: string; B: string }; accounts: Array<{ id: string; name: string }> }) {
  const pre = [...(p?.pretax ?? []), ...Array.from({ length: Math.max(1, 4 - (p?.pretax.length ?? 0)) }, () => null)];
  const post = [...(p?.posttax ?? []), ...Array.from({ length: Math.max(1, 2 - (p?.posttax.length ?? 0)) }, () => null)];
  const dRow = (prefix: string, d: Paycheck["pretax"][number] | null, i: number) => (
    <div key={`${prefix}${i}`} className="grid grid-cols-[1fr_11rem_7rem] gap-2">
      <input name={`${prefix}Label`} defaultValue={d?.label ?? ""} placeholder="Label" aria-label="Deduction label" />
      <select name={`${prefix}Kind`} defaultValue={d?.kind ?? (prefix === "pre" ? "retirement_pretax" : "roth_retirement")} aria-label="Kind">
        {KINDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <input name={`${prefix}Amount`} inputMode="decimal" defaultValue={dollarsInput(d?.amount)} placeholder="0.00" aria-label="Amount" />
    </div>
  );
  return (
    <ActionForm action={savePaycheck} className="space-y-3">
      {p && <input type="hidden" name="id" value={p.id} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Whose"><select name="owner" defaultValue={p?.owner ?? "A"}><option value="A">{names.A}</option><option value="B">{names.B}</option></select></Field>
        <Field label="Employer"><input name="employer" defaultValue={p?.employer} required /></Field>
        <Field label="Pay frequency">
          <select name="frequency" defaultValue={p?.frequency ?? "biweekly"}>
            <option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="semimonthly">Twice a month</option><option value="monthly">Monthly</option>
          </select>
        </Field>
        <Field label="Deposited to">
          <select name="depositAccountId" defaultValue={p?.depositAccountId ?? ""}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
        <Field label="Gross pay (per check)"><input name="gross" inputMode="decimal" defaultValue={dollarsInput(p?.gross)} required /></Field>
        <Field label="All taxes withheld" hint="Federal + state + local + FICA"><input name="taxes" inputMode="decimal" defaultValue={dollarsInput(p?.taxes)} /></Field>
        <Field label="Employer match/HSA (per check)" hint="Not in gross"><input name="employerContrib" inputMode="decimal" defaultValue={dollarsInput(p?.employerContrib)} /></Field>
        <Field label="Net deposit"><input name="net" inputMode="decimal" defaultValue={dollarsInput(p?.net)} required /></Field>
      </div>
      <div><div className="mb-1 text-xs text-muted">Pre-tax deductions</div><div className="space-y-2">{pre.map((d, i) => dRow("pre", d, i))}</div></div>
      <div><div className="mb-1 text-xs text-muted">After-tax deductions</div><div className="space-y-2">{post.map((d, i) => dRow("post", d, i))}</div></div>
      <Submit>{p ? "Save" : "Add paycheck"}</Submit>
    </ActionForm>
  );
}

export default async function IncomePage() {
  const ctx = await getContext();
  const paychecks = loadPaychecks(ctx.householdId);
  const accounts = loadAccounts(ctx.householdId).filter((a) => a.type === "checking" || a.type === "savings").map((a) => ({ id: a.id, name: a.name }));
  const m = monthlyIncomeModel(paychecks);
  return (
    <>
      <PageHeader title="Paychecks" subtitle="Grab a recent pay stub. This is what makes your savings rate honest: your 401(k), HSA, and match never hit your bank account." />
      {paychecks.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <Stat label="Gross / month" value={formatCents(m.gross, { noCents: true })} />
          <Stat label="Take-home / month" value={formatCents(m.net, { noCents: true })} />
          <Stat label="Payroll savings / month" value={formatCents(m.payrollSavings, { noCents: true })} hint="Incl. employer contributions" />
          <Stat label="Effective tax rate" value={pct(m.gross ? m.taxes / m.gross : null, 1)} hint="Withholding ÷ gross" />
        </div>
      )}
      <div className="space-y-4">
        {paychecks.map((p) => (
          <Card key={p.id} title={`${p.owner === "A" ? ctx.names.A : ctx.names.B} · ${p.employer}`} subtitle={<>Monthly: gross <Money cents={monthly(p.gross, p.frequency)} noCents />, net <Money cents={monthly(p.net, p.frequency)} noCents />{Math.abs(computedNet(p) - p.net) > 1 && <span className="text-warn"> · Stub doesn't balance by {formatCents(computedNet(p) - p.net)}</span>}</>}
            action={<form action={deletePaycheck}><input type="hidden" name="id" value={p.id} /><button className="text-xs text-muted hover:text-bad">Remove</button></form>}>
            <PaycheckForm p={p} names={ctx.names} accounts={accounts} />
          </Card>
        ))}
        <Card title="Add a paycheck"><PaycheckForm names={ctx.names} accounts={accounts} /></Card>
      </div>
    </>
  );
}
