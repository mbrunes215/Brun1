import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hearth-backup-"));
process.env.DATA_DIR = dir;
process.env.MIGRATIONS_DIR = path.join(__dirname, "..", "drizzle");
process.env.APP_SECRET = "test-secret-test-secret-test-secret-123";

describe("encrypted backups", () => {
  it("round-trips through backup, prune, and the restore script", async () => {
    const { getDb, schema } = await import("@/db");
    const { runBackup, prune } = await import("@/server/backup");
    getDb().insert(schema.households).values({ id: "h1", name: "Backup Test" }).run();
    const file = await runBackup(new Date("2026-11-20T12:00:00Z"));
    const raw = fs.readFileSync(file);
    expect(raw.subarray(0, 5).toString()).toBe("HRTH1");
    expect(raw.includes(Buffer.from("Backup Test"))).toBe(false); // encrypted, not plaintext

    // Retention: 30 days of dailies + 12 monthlies.
    const bdir = path.dirname(file);
    for (const d of ["2026-10-25", "2026-09-03", "2026-09-15", "2024-01-01"]) fs.writeFileSync(path.join(bdir, `hearth-${d}.db.gz.enc`), "x");
    prune(bdir, new Date("2026-11-20T12:00:00Z"));
    const left = fs.readdirSync(bdir).sort();
    expect(left).toContain("hearth-2026-10-25.db.gz.enc"); // within 30 days
    expect(left).toContain("hearth-2026-09-15.db.gz.enc"); // newest of its month
    expect(left).not.toContain("hearth-2026-09-03.db.gz.enc");

    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearth-restore-"));
    execFileSync("node", [path.join(__dirname, "..", "scripts", "restore.mjs"), file], { env: { ...process.env, DATA_DIR: restoreDir } });
    const restored = new Database(path.join(restoreDir, "hearth.db"), { readonly: true });
    expect(restored.prepare("select name from households where id='h1'").get()).toEqual({ name: "Backup Test" });
  });
});
