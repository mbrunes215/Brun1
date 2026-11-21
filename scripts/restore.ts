/**
 * Restore a Hearth backup:
 *   docker compose stop hearth
 *   docker compose run --rm hearth node scripts/restore.mjs /data/backups/hearth-2026-11-20.db.gz.enc
 *   docker compose start hearth
 * (Locally: npx tsx scripts/restore.ts <file>.) The current database is moved aside, not deleted.
 */
import fs from "node:fs";
import path from "node:path";
import { decryptBackup } from "../src/server/backup";

const file = process.argv[2];
if (!file) {
  console.error("Usage: restore <backup-file>");
  process.exit(1);
}
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const target = path.join(dataDir, "hearth.db");
const db = decryptBackup(file);
if (fs.existsSync(target)) {
  const aside = `${target}.before-restore-${Date.now()}`;
  fs.renameSync(target, aside);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(target + ext)) fs.rmSync(target + ext);
  console.log(`Current database moved to ${aside}`);
}
fs.writeFileSync(target, db, { mode: 0o600 });
console.log(`Restored ${file} -> ${target}`);
