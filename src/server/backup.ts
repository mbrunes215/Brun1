import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { dataDir, getSqlite } from "@/db";

/**
 * Nightly backups: SQLite online backup (consistent while the app runs),
 * gzip, then AES-256-GCM encryption with a key derived from BACKUP_PASSPHRASE
 * (falls back to APP_SECRET). Retention: 30 daily + 12 monthly.
 * Sync the backups folder off-site (rclone, Syncthing, NAS snapshot) — a backup
 * on the same disk doesn't survive that disk failing.
 */

export function backupDir() {
  return process.env.BACKUP_DIR ?? path.join(dataDir(), "backups");
}

function key(salt: Buffer) {
  const pass = process.env.BACKUP_PASSPHRASE || process.env.APP_SECRET;
  if (!pass) throw new Error("Set BACKUP_PASSPHRASE (or APP_SECRET) to enable encrypted backups.");
  return crypto.scryptSync(pass, salt, 32);
}

export async function runBackup(now = new Date()): Promise<string> {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  const tmp = path.join(dir, `.tmp-${stamp}.db`);
  await getSqlite().backup(tmp);
  const raw = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  const gz = zlib.gzipSync(raw);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(salt), iv);
  const enc = Buffer.concat([c.update(gz), c.final()]);
  const out = Buffer.concat([Buffer.from("HRTH1"), salt, iv, c.getAuthTag(), enc]);
  const file = path.join(dir, `hearth-${stamp}.db.gz.enc`);
  fs.writeFileSync(file, out, { mode: 0o600 });
  prune(dir, now);
  return file;
}

export function decryptBackup(file: string): Buffer {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 5).toString() !== "HRTH1") throw new Error("Not a Hearth backup");
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(33, 49);
  const d = crypto.createDecipheriv("aes-256-gcm", key(salt), iv);
  d.setAuthTag(tag);
  return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(49)), d.final()]));
}

export function prune(dir: string, now: Date) {
  const files = fs.readdirSync(dir).filter((f) => /^hearth-\d{4}-\d{2}-\d{2}\.db\.gz\.enc$/.test(f)).sort().reverse();
  const keep = new Set<string>();
  const months = new Set<string>();
  for (const f of files) {
    const d = f.slice(7, 17);
    const ageDays = (now.getTime() - Date.parse(d)) / 86_400_000;
    if (ageDays <= 30) keep.add(f);
    const m = d.slice(0, 7);
    if (!months.has(m) && months.size < 12) {
      months.add(m);
      keep.add(f);
    }
  }
  for (const f of files) if (!keep.has(f)) fs.rmSync(path.join(dir, f));
}

export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".enc"))
    .sort()
    .reverse()
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
}
