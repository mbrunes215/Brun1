import { defaultCategories } from "../categories";
import type { Account, Transaction } from "../types";

export const categories = defaultCategories({ A: "Matt", B: "Partner" });

export const C = {
  paycheck: "income_paychecks",
  groceries: "food_groceries",
  dining: "food_restaurants_and_takeout",
  rent: "housing_rent",
  internet: "utilities_internet",
  autoIns: "transportation_auto_insurance",
  transfer: "transfers_transfer",
  ccPayment: "transfers_credit_card_payment",
  savings: "savings_and_investing_savings_contribution",
  carPayment: "transportation_car_payment",
  funA: "personal_fun_money_partner_a",
  shopping: "shopping_general_merchandise",
} as const;

export const accounts: Account[] = [
  { id: "chkA", name: "Matt Checking", type: "checking", owner: "A", balance: 500000 },
  { id: "chkB", name: "Partner Checking", type: "checking", owner: "B", balance: 300000 },
  { id: "joint", name: "Joint Checking", type: "checking", owner: "joint", balance: 200000 },
  { id: "ccA", name: "Matt Visa", type: "credit_card", owner: "A", balance: -120000, creditLimit: 1000000, apr: 0.2299 },
  { id: "hysa", name: "Joint HYSA", type: "savings", owner: "joint", balance: 1500000 },
  { id: "brokerage", name: "Brokerage", type: "brokerage", owner: "A", balance: 4000000 },
  { id: "auto", name: "Auto loan", type: "auto_loan", owner: "B", balance: -1800000, apr: 0.059, minPayment: 45000 },
];

let n = 0;
export function txn(p: Partial<Transaction> & Pick<Transaction, "accountId" | "date" | "amount">): Transaction {
  n++;
  return { id: p.id ?? `t${n}`, payeeRaw: p.payeeRaw ?? "Test", categoryId: p.categoryId ?? null, ...p };
}
