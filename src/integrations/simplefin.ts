/**
 * SimpleFIN client, per the SimpleFIN protocol spec
 * (github.com/simplefin/simplefin.github.com, protocol.md):
 *
 * - A setup token is a base64-encoded claim URL; POST to it once to receive an
 *   Access URL containing Basic Auth credentials. A 403 means the token was
 *   already claimed, which may mean it was compromised.
 * - GET {access}/accounts?start-date=<epoch>&pending=1&version=2 returns an
 *   Account Set: { errlist, connections, accounts[] }.
 * - Amounts are numeric strings; positive = money deposited into the account.
 *   Timestamps are Unix epoch seconds. The spec does not define account types
 *   or holdings, so types are inferred from names and confirmed by the user.
 * - The Bridge enforces a request quota that replenishes through the day, so
 *   syncs are scheduled sparingly and manual syncs have a cooldown.
 */

export interface SfError {
  code: string;
  msg: string;
  conn_id?: string;
  account_id?: string;
}
export interface SfConnection {
  conn_id: string;
  name: string;
  org_id: string;
  org_url?: string;
  sfin_url?: string;
}
export interface SfTransaction {
  id: string;
  posted: number;
  amount: string;
  description: string;
  transacted_at?: number;
  pending?: boolean;
  payee?: string;
  memo?: string;
  extra?: Record<string, unknown>;
}
export interface SfAccount {
  id: string;
  name: string;
  conn_id?: string;
  conn_name?: string;
  org?: { name?: string; domain?: string };
  currency: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  transactions?: SfTransaction[];
  extra?: Record<string, unknown>;
}
export interface SfAccountSet {
  errlist?: SfError[];
  errors?: string[];
  connections?: SfConnection[];
  accounts: SfAccount[];
}

export class SimpleFinError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export function decodeSetupToken(token: string): string {
  const trimmed = token.trim();
  let url: string;
  try {
    url = Buffer.from(trimmed, "base64").toString("utf8").trim();
  } catch {
    throw new SimpleFinError("That doesn't look like a SimpleFIN setup token.");
  }
  if (!/^https:\/\//.test(url)) throw new SimpleFinError("That doesn't look like a SimpleFIN setup token (expected an HTTPS URL inside).");
  return url;
}

export async function claimAccessUrl(setupToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const res = await fetchImpl(claimUrl, { method: "POST", headers: { "Content-Length": "0" } });
  if (res.status === 403) {
    throw new SimpleFinError(
      "This setup token was already claimed. If you didn't claim it, disable it in SimpleFIN Bridge now: your data may be exposed.",
      403,
    );
  }
  if (!res.ok) throw new SimpleFinError(`Claim failed (HTTP ${res.status}).`, res.status);
  const access = (await res.text()).trim();
  if (!/^https:\/\/[^:]+:[^@]+@/.test(access)) throw new SimpleFinError("Unexpected claim response.");
  return access;
}

/** Split credentials out of the access URL (fetch rejects URLs with embedded credentials). */
export function parseAccessUrl(access: string): { base: string; authHeader: string } {
  const u = new URL(access);
  if (u.protocol !== "https:") throw new SimpleFinError("Access URL must be HTTPS.");
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
  u.username = "";
  u.password = "";
  return { base: u.toString().replace(/\/$/, ""), authHeader: `Basic ${auth}` };
}

export async function fetchAccounts(
  access: string,
  opts: { startDate?: Date; endDate?: Date; pending?: boolean; balancesOnly?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SfAccountSet> {
  const { base, authHeader } = parseAccessUrl(access);
  const q = new URLSearchParams();
  if (opts.startDate) q.set("start-date", String(Math.floor(opts.startDate.getTime() / 1000)));
  if (opts.endDate) q.set("end-date", String(Math.floor(opts.endDate.getTime() / 1000)));
  if (opts.pending ?? true) q.set("pending", "1");
  if (opts.balancesOnly) q.set("balances-only", "1");
  q.set("version", "2");
  const res = await fetchImpl(`${base}/accounts?${q}`, { headers: { Authorization: authHeader } });
  if (res.status === 403) throw new SimpleFinError("SimpleFIN rejected the credentials (access revoked?). Reconnect in Settings.", 403);
  if (res.status === 402) throw new SimpleFinError("SimpleFIN Bridge says payment is required for this account.", 402);
  if (!res.ok) throw new SimpleFinError(`SimpleFIN request failed (HTTP ${res.status}).`, res.status);
  const data = (await res.json()) as SfAccountSet;
  if (!Array.isArray(data.accounts)) throw new SimpleFinError("Malformed SimpleFIN response.");
  return data;
}

/** Errors to show users (sanitized: plain text, length-limited). */
export function userErrors(set: SfAccountSet): string[] {
  const msgs = [...(set.errlist ?? []).map((e) => e.msg), ...(set.errors ?? [])];
  return msgs.map((m) => String(m).replace(/[<>]/g, "").slice(0, 300));
}

export function parseAmountToCents(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new SimpleFinError(`Bad amount: ${s}`);
  return Math.round(n * 100);
}

/** Epoch seconds -> YYYY-MM-DD in the given IANA time zone. */
export function epochToDate(epoch: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch * 1000));
}

/** Best-effort account type from the name; the user confirms on first sync. */
export function guessAccountType(name: string): string {
  const n = name.toLowerCase();
  if (/roth/.test(n)) return "roth_ira";
  if (/401\s?\(?k|403\s?\(?b|457|tsp\b/.test(n)) return "retirement_401k";
  if (/\bira\b|rollover/.test(n)) return "ira";
  if (/\bhsa\b|health savings/.test(n)) return "hsa";
  if (/529/.test(n)) return "education_529";
  if (/brokerage|individual|invest|trading/.test(n)) return "brokerage";
  if (/mortgage|home loan/.test(n)) return "mortgage";
  if (/heloc|home equity/.test(n)) return "heloc";
  if (/auto|car loan|vehicle/.test(n)) return "auto_loan";
  if (/student/.test(n)) return "student_loan";
  if (/loan/.test(n)) return "personal_loan";
  if (/credit|card|visa|mastercard|amex|express|discover|sapphire|freedom|venture|rewards/.test(n)) return "credit_card";
  if (/savings|money market|mmda|hysa/.test(n)) return "savings";
  if (/\bcd\b|certificate/.test(n)) return "cd";
  if (/crypto|coinbase|bitcoin/.test(n)) return "crypto";
  return "checking";
}
