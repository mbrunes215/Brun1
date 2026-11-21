import Papa from "papaparse";

/**
 * CSV and OFX/QFX import. Bank CSVs vary wildly, so the user maps columns once
 * per account and the mapping is saved. Amount conventions handled:
 * - single signed amount column (with optional "flip sign" for card exports
 *   that show purchases as positive)
 * - separate debit / credit columns
 */

export interface ParsedRow {
  date: string; // YYYY-MM-DD
  amount: number; // cents, signed (negative = outflow)
  payee: string;
  externalId?: string;
  category?: string;
}

export interface CsvMapping {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  category?: string;
  flipSign?: boolean;
  dateFormat?: "auto" | "MDY" | "DMY" | "YMD";
}

export function parseCsvText(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  return { headers: res.meta.fields ?? [], rows: res.data };
}

export function guessMapping(headers: string[]): CsvMapping {
  const find = (re: RegExp) => headers.find((h) => re.test(h));
  const amount = find(/^amount$|amount \(|^amt$/i) ?? find(/amount/i);
  const debit = find(/debit|withdrawal|outflow|charge/i);
  const credit = find(/credit|deposit|inflow|payment/i);
  return {
    date: find(/posted|post date|transaction date|^date$/i) ?? find(/date/i) ?? headers[0] ?? "",
    description: find(/description|payee|merchant|name|memo|details/i) ?? headers[1] ?? "",
    amount: amount && !(debit && credit && !/^amount$/i.test(amount)) ? amount : undefined,
    debit: amount ? undefined : debit,
    credit: amount ? undefined : credit,
    category: find(/category/i),
    dateFormat: "auto",
  };
}

export function parseDateFlexible(raw: string, fmt: CsvMapping["dateFormat"] = "auto"): string | null {
  const s = raw.trim().split(/[ T]/)[0] ?? "";
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += 2000;
    const a = +m[1]!;
    const b = +m[2]!;
    const dmy = fmt === "DMY" || (fmt === "auto" && a > 12);
    return dmy ? iso(y, b, a) : iso(y, a, b);
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})/); // OFX 20260315
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseMoney(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /-/.test(s) || /\bDR\b/i.test(s);
  s = s.replace(/[()$,\s]|CR|DR|-/gi, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

export function applyMapping(rows: Record<string, string>[], m: CsvMapping): { rows: ParsedRow[]; errors: string[] } {
  const out: ParsedRow[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const date = parseDateFlexible(r[m.date] ?? "", m.dateFormat);
    let amount: number | null = null;
    if (m.amount) amount = parseMoney(r[m.amount]);
    else {
      const d = parseMoney(r[m.debit ?? ""]);
      const c = parseMoney(r[m.credit ?? ""]);
      if (d != null || c != null) amount = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
    }
    const payee = (r[m.description] ?? "").trim();
    if (!date || amount == null || !payee) {
      errors.push(`Row ${i + 2}: could not read ${!date ? "date" : amount == null ? "amount" : "description"}`);
      return;
    }
    out.push({ date, amount: m.flipSign ? -amount : amount, payee, category: m.category ? r[m.category] : undefined });
  });
  return { rows: out, errors };
}

/** Minimal OFX/QFX (SGML or XML) transaction parser. */
export function parseOfx(text: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const tag = (b: string, t: string) => {
    const m = b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, "i"));
    return m ? m[1]!.trim() : undefined;
  };
  for (const b of blocks) {
    const body = b.split(/<\/STMTTRN>/i)[0]!;
    const date = parseDateFlexible(tag(body, "DTPOSTED") ?? "");
    const amount = parseMoney(tag(body, "TRNAMT"));
    const payee = [tag(body, "NAME"), tag(body, "MEMO")].filter(Boolean).join(" ").trim();
    if (!date || amount == null) continue;
    out.push({ date, amount, payee: payee || "Unknown", externalId: tag(body, "FITID") });
  }
  return out;
}
