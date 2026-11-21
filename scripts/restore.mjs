// Restore an encrypted Hearth backup (plain JS so it runs inside the container).
//   docker compose stop hearth
//   docker compose run --rm hearth node scripts/restore.mjs /data/backups/hearth-YYYY-MM-DD.db.gz.enc
//   docker compose start hearth
// The current database is moved aside, never deleted.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/restore.mjs <backup-file>");
  process.exit(1);
}
const pass = process.env.BACKUP_PASSPHRASE || process.env.APP_SECRET;
if (!pass) {
  console.error("Set BACKUP_PASSPHRASE or APP_SECRET (the one used when the backup was made).");
  process.exit(1);
}
const buf = fs.readFileSync(file);
if (buf.subarray(0, 5).toString() !== "HRTH1") throw new Error("Not a Hearth backup");
const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49);
const d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(pass, salt, 32), iv);
d.setAuthTag(tag);
const db = zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(49)), d.final()]));
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const target = path.join(dataDir, "hearth.db");
if (fs.existsSync(target)) {
  const aside = `${target}.before-restore-${Date.now()}`;
  fs.renameSync(target, aside);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(target + ext)) fs.rmSync(target + ext);
  console.log(`Current database moved to ${aside}`);
}
fs.writeFileSync(target, db, { mode: 0o600 });
console.log(`Restored ${path.basename(file)} -> ${target}`);
