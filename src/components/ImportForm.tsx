"use client";

import { useState } from "react";
import Papa from "papaparse";
import { ActionForm, Submit, type ActionResult } from "./ActionForm";
import { guessMapping, type CsvMapping } from "@/integrations/fileImport";

export function ImportForm({
  accounts,
  action,
  savedMappings,
}: {
  accounts: Array<{ id: string; name: string }>;
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  savedMappings: Record<string, CsvMapping>;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [headers, setHeaders] = useState<string[]>([]);
  const [preview, setPreview] = useState<string[][]>([]);
  const [isOfx, setIsOfx] = useState(false);
  const [m, setM] = useState<CsvMapping | null>(null);

  async function onFile(f: File | undefined) {
    if (!f) return;
    const text = await f.slice(0, 64 * 1024).text();
    if (/<OFX>|OFXHEADER/i.test(text)) {
      setIsOfx(true);
      setHeaders([]);
      return;
    }
    setIsOfx(false);
    const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: true });
    const rows = res.data;
    const hs = (rows[0] ?? []).map((h) => h.trim());
    setHeaders(hs);
    setPreview(rows.slice(1, 4));
    setM(savedMappings[accountId] && hs.includes(savedMappings[accountId].date) ? savedMappings[accountId] : guessMapping(hs));
  }

  const col = (name: keyof CsvMapping, label: string, optional = false) => (
    <div className="space-y-1">
      <label>{label}</label>
      <select name={`col${name[0]!.toUpperCase()}${name.slice(1)}`} value={(m?.[name] as string) ?? ""} onChange={(e) => setM((p) => ({ ...(p as CsvMapping), [name]: e.target.value || undefined }))}>
        {optional && <option value="">(none)</option>}
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <ActionForm action={action} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label>Account</label>
          <select name="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label>File (CSV, OFX, or QFX)</label>
          <input type="file" name="file" accept=".csv,.ofx,.qfx,text/csv" required onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
      </div>
      {isOfx && <p className="text-sm text-muted">OFX/QFX detected. Columns are standard, so no mapping is needed.</p>}
      {headers.length > 0 && m && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <p className="text-sm font-medium">Map columns</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {col("date", "Date")}
            {col("description", "Description")}
            {col("amount", "Amount (signed)", true)}
            {col("debit", "Debit / withdrawal", true)}
            {col("credit", "Credit / deposit", true)}
            <div className="space-y-1">
              <label>Date format</label>
              <select name="dateFormat" defaultValue={m.dateFormat ?? "auto"}>
                <option value="auto">Auto-detect</option>
                <option value="MDY">MM/DD/YYYY</option>
                <option value="DMY">DD/MM/YYYY</option>
                <option value="YMD">YYYY-MM-DD</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" name="flipSign" defaultChecked={m.flipSign} /> Purchases show as positive numbers (common in credit card exports): flip signs
          </label>
          {preview.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>{headers.map((h) => <th key={h} className="px-2 py-1 text-left text-muted">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-t border-line">{r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <Submit>Import</Submit>
    </ActionForm>
  );
}
