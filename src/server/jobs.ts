import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { syncHousehold, snapshotAll } from "./sync";
import { runAlerts } from "./alerts";
import { runBackup } from "./backup";

/** In-process scheduler with a DB lock so overlapping runs (or two instances) don't collide. */

function withLock(name: string, ttlMs: number, fn: () => Promise<string>) {
  return async () => {
    const db = getDb();
    const now = Date.now();
    const row = db.select().from(schema.jobLocks).where(eq(schema.jobLocks.name, name)).get();
    if (row && row.lockedUntil > now) return;
    db.insert(schema.jobLocks)
      .values({ name, lockedUntil: now + ttlMs })
      .onConflictDoUpdate({ target: schema.jobLocks.name, set: { lockedUntil: now + ttlMs } })
      .run();
    let result = "ok";
    try {
      result = await fn();
    } catch (e) {
      result = `error: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[job ${name}]`, e);
    } finally {
      db.update(schema.jobLocks).set({ lockedUntil: 0, lastRunAt: new Date().toISOString(), lastResult: result.slice(0, 500) }).where(eq(schema.jobLocks.name, name)).run();
    }
  };
}

const households = () => getDb().select().from(schema.households).all();

export async function dailySync(): Promise<string> {
  const out: string[] = [];
  for (const h of households()) {
    const r = await syncHousehold(h.id);
    snapshotAll(h.id);
    runAlerts(h.id);
    out.push(`${h.id.slice(0, 8)}: ${r.filter((x) => x.ok).length}/${r.length} ok`);
  }
  return out.join("; ") || "no households";
}

export function startJobs() {
  const g = globalThis as unknown as { __hearthJobs?: Cron[] };
  if (g.__hearthJobs || process.env.DISABLE_JOBS === "1") return;
  const tz = households()[0]?.timezone ?? "America/New_York";
  g.__hearthJobs = [
    // Banks generally post overnight. One morning sync keeps well inside SimpleFIN's daily quota.
    new Cron(process.env.SYNC_CRON ?? "15 6 * * *", { timezone: tz, protect: true }, withLock("daily_sync", 30 * 60_000, dailySync)),
    new Cron("0 18 * * *", { timezone: tz, protect: true }, withLock("evening_alerts", 10 * 60_000, async () => {
      for (const h of households()) {
        snapshotAll(h.id);
        runAlerts(h.id);
      }
      return "ok";
    })),
    new Cron(process.env.BACKUP_CRON ?? "30 2 * * *", { timezone: tz, protect: true }, withLock("backup", 30 * 60_000, async () => runBackup())),
  ];
  console.log(`[hearth] scheduler started (${tz})`);
}
