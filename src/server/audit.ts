import { getDb, schema } from "@/db";

export function audit(householdId: string, userId: string | null, action: string, entity?: string, entityId?: string, detail?: Record<string, unknown>) {
  getDb().insert(schema.auditLog).values({ householdId, userId, action, entity, entityId, detail }).run();
}
