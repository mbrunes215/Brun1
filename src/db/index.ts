import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

export function openDb(file?: string): { db: DB; sqlite: Database.Database } {
  const dbFile = file ?? path.join(dataDir(), "hearth.db");
  if (dbFile !== ":memory:") fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const sqlite = new Database(dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
  migrate(db, { migrationsFolder });
  return { db, sqlite };
}

const g = globalThis as unknown as { __hearthDb?: { db: DB; sqlite: Database.Database } };

/** Process-wide singleton (survives Next.js dev hot reloads). */
export function getDb(): DB {
  if (!g.__hearthDb) g.__hearthDb = openDb();
  return g.__hearthDb.db;
}

export function getSqlite(): Database.Database {
  if (!g.__hearthDb) g.__hearthDb = openDb();
  return g.__hearthDb.sqlite;
}

export { schema };
