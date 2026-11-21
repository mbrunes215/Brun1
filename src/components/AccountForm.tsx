import { ActionForm, Submit } from "./ActionForm";
import { Field, dollarsInput } from "./ui";
import { saveAccount } from "@/server/actions";
import { ACCOUNT_TYPE_LABELS, LIABILITY_TYPES } from "@/domain/accounts";
import type { AccountRow } from "@/server/repo";
import type { AccountType } from "@/domain/types";

export function AccountForm({ account, names, assets }: { account?: AccountRow; names: { A: string; B: string }; assets: AccountRow[] }) {
  const manual = !account || account.isManual;
  const isLiab = account ? LIABILITY_TYPES.has(account.type as AccountType) : false;
  return (
    <ActionForm action={saveAccount} className="grid gap-3 sm:grid-cols-2">
      {account && <input type="hidden" name="id" value={account.id} />}
      <Field label="Name">
        <input name="name" defaultValue={account?.name} required />
      </Field>
      <Field label="Institution">
        <input name="institution" defaultValue={account?.institution ?? ""} />
      </Field>
      <Field label="Type" hint={account && !account.isManual ? "Guessed from the bank's account name. Correct it if needed: it drives how transfers and net worth are treated." : undefined}>
        <select name="type" defaultValue={account?.type ?? "checking"}>
          {Object.entries(ACCOUNT_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Owner">
        <select name="owner" defaultValue={account?.owner ?? "joint"}>
          <option value="A">{names.A}</option>
          <option value="B">{names.B}</option>
          <option value="joint">Joint</option>
        </select>
      </Field>
      {manual && (
        <Field label={isLiab ? "Amount owed" : "Current balance / value"} hint="Debts: enter the amount owed as a positive number.">
          <input name="balance" inputMode="decimal" defaultValue={account ? dollarsInput(Math.abs(account.balance)) : ""} />
        </Field>
      )}
      <Field label="Annual value change %" hint="Manual assets only. Vehicles: about -15. Home: your estimate, e.g. 3.">
        <input name="valueChangeRate" inputMode="decimal" defaultValue={account?.valueChangeRate != null ? (account.valueChangeRate * 100).toString() : ""} />
      </Field>
      <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:col-span-2 sm:grid-cols-3">
        <legend className="px-1 text-xs text-muted">Debt details (cards and loans)</legend>
        <Field label="APR %">
          <input name="apr" inputMode="decimal" defaultValue={account?.apr != null ? (account.apr * 100).toFixed(2) : ""} />
        </Field>
        <Field label="Minimum payment">
          <input name="minPayment" inputMode="decimal" defaultValue={dollarsInput(account?.minPayment)} />
        </Field>
        <Field label="Credit limit">
          <input name="creditLimit" inputMode="decimal" defaultValue={dollarsInput(account?.creditLimit)} />
        </Field>
        <Field label="0% promo ends">
          <input name="promoAprEnd" type="date" defaultValue={account?.promoAprEnd ?? ""} />
        </Field>
        <Field label="Statement closes on day">
          <input name="statementCloseDay" type="number" min={1} max={31} defaultValue={account?.statementCloseDay ?? ""} />
        </Field>
        <Field label="Secured by (mortgage → home)">
          <select name="linkedAssetId" defaultValue={account?.linkedAssetId ?? ""}>
            <option value="">—</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:col-span-2 sm:grid-cols-2">
        <legend className="px-1 text-xs text-muted">Planning</legend>
        <Field label="Tax treatment">
          <select name="taxBucket" defaultValue={account?.taxBucket ?? ""}>
            <option value="">Default for type</option>
            <option value="taxable">Taxable</option>
            <option value="tax_deferred">Tax-deferred (traditional)</option>
            <option value="tax_free">Tax-free (Roth)</option>
            <option value="hsa">HSA</option>
            <option value="education">Education (529)</option>
            <option value="none">Not applicable</option>
          </select>
        </Field>
        <Field label="Liquidity">
          <select name="liquidity" defaultValue={account?.liquidity ?? ""}>
            <option value="">Default for type</option>
            <option value="cash">Cash (spendable today)</option>
            <option value="near_cash">Near-cash (savings, money market)</option>
            <option value="invested">Invested (taxable)</option>
            <option value="retirement">Retirement (penalty before 59½)</option>
            <option value="illiquid">Illiquid (home, car)</option>
            <option value="liability">Liability</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" name="excludeFromCashFlow" defaultChecked={account?.excludeFromCashFlow} /> Exclude from budgets and cash flow (e.g. business account)
        </label>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" name="isHidden" defaultChecked={account?.isHidden} /> Hide account everywhere
        </label>
      </fieldset>
      <div className="sm:col-span-2">
        <Submit>{account ? "Save account" : "Add account"}</Submit>
      </div>
    </ActionForm>
  );
}
