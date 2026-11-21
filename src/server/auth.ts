import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { decrypt, encrypt, newId, randomToken, sha256 } from "./crypto";
import { generateTotpSecret, verifyTotp } from "./totp";
import { audit } from "./audit";
import { seedHousehold } from "./seed";

const COOKIE = "hearth_session";
const SESSION_DAYS = 30;
const PENDING_MFA_MINUTES = 10;

export type SessionUser = typeof schema.users.$inferSelect & { mfaPassed: boolean };

export async function hashPassword(pw: string): Promise<string> {
  return hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters.";
  return null;
}

export function userCount(): number {
  return getDb().select({ id: schema.users.id }).from(schema.users).all().length;
}

async function startSession(userId: string, mfaPassed: boolean) {
  const token = randomToken();
  const minutes = mfaPassed ? SESSION_DAYS * 24 * 60 : PENDING_MFA_MINUTES;
  getDb()
    .insert(schema.sessions)
    .values({ id: sha256(token), userId, mfaPassed, expiresAt: Date.now() + minutes * 60_000 })
    .run();
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: minutes * 60,
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const row = db
    .select()
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, Date.now())))
    .get();
  if (!row) return null;
  return { ...row.users, mfaPassed: row.sessions.mfaPassed };
}

/** For pages and actions: a fully authenticated user (password + 2FA when enabled). */
export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) redirect(userCount() === 0 ? "/setup" : "/login");
  if (u.totpEnabled && !u.mfaPassed) redirect("/login/2fa");
  return u;
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) getDb().delete(schema.sessions).where(eq(schema.sessions.id, sha256(token))).run();
  jar.delete(COOKIE);
}

/** First run: create the household and the first (admin) user. */
export async function createOwner(input: { householdName: string; name: string; email: string; password: string; partnerName: string }) {
  if (userCount() > 0) throw new Error("Setup already completed.");
  const err = validatePassword(input.password);
  if (err) throw new Error(err);
  const db = getDb();
  const householdId = newId();
  const userId = newId();
  const passwordHash = await hashPassword(input.password);
  db.transaction((tx) => {
    tx.insert(schema.households)
      .values({ id: householdId, name: input.householdName, settings: { partnerNames: { A: input.name, B: input.partnerName } } })
      .run();
    tx.insert(schema.users)
      .values({ id: userId, householdId, email: input.email.toLowerCase().trim(), name: input.name, slot: "A", passwordHash, isAdmin: true })
      .run();
  });
  seedHousehold(householdId, { A: input.name, B: input.partnerName });
  audit(householdId, userId, "setup.owner_created");
  await startSession(userId, true);
}

export function createInvite(householdId: string, createdBy: string): string {
  const token = randomToken(24);
  getDb()
    .insert(schema.invites)
    .values({ id: sha256(token), householdId, createdBy, expiresAt: Date.now() + 7 * 86_400_000 })
    .run();
  audit(householdId, createdBy, "invite.created");
  return token;
}

export async function acceptInvite(token: string, input: { name: string; email: string; password: string }) {
  const db = getDb();
  const inv = db
    .select()
    .from(schema.invites)
    .where(and(eq(schema.invites.id, sha256(token)), isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, Date.now())))
    .get();
  if (!inv) throw new Error("This invite link is invalid or expired.");
  const existing = db.select().from(schema.users).where(eq(schema.users.householdId, inv.householdId)).all();
  if (existing.some((u) => u.slot === "B")) throw new Error("This household already has two members.");
  const err = validatePassword(input.password);
  if (err) throw new Error(err);
  const userId = newId();
  const passwordHash = await hashPassword(input.password);
  db.transaction((tx) => {
    tx.insert(schema.users)
      .values({ id: userId, householdId: inv.householdId, email: input.email.toLowerCase().trim(), name: input.name, slot: "B", passwordHash })
      .run();
    tx.update(schema.invites).set({ usedAt: new Date().toISOString() }).where(eq(schema.invites.id, inv.id)).run();
    const hh = tx.select().from(schema.households).where(eq(schema.households.id, inv.householdId)).get();
    const settings = (hh?.settings ?? {}) as { partnerNames?: { A: string; B: string } };
    tx.update(schema.households)
      .set({ settings: { ...settings, partnerNames: { A: settings.partnerNames?.A ?? "Partner A", B: input.name } } })
      .where(eq(schema.households.id, inv.householdId))
      .run();
  });
  audit(inv.householdId, userId, "invite.accepted");
  await startSession(userId, true);
}

// Simple in-memory throttle: 10 failed attempts per email per 15 minutes.
const failures = new Map<string, number[]>();
function throttled(key: string): boolean {
  const now = Date.now();
  const recent = (failures.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  failures.set(key, recent);
  return recent.length >= 10;
}
function fail(key: string) {
  failures.set(key, [...(failures.get(key) ?? []), Date.now()]);
}

export async function login(email: string, password: string): Promise<"ok" | "mfa" | "invalid" | "throttled"> {
  const key = email.toLowerCase().trim();
  if (throttled(key)) return "throttled";
  const user = getDb().select().from(schema.users).where(eq(schema.users.email, key)).get();
  // Verify against a dummy hash when the user doesn't exist to keep timing similar.
  const ok = user ? await verify(user.passwordHash, password) : (await hashPassword(password), false);
  if (!user || !ok) {
    fail(key);
    return "invalid";
  }
  await startSession(user.id, !user.totpEnabled);
  audit(user.householdId, user.id, "auth.login");
  return user.totpEnabled ? "mfa" : "ok";
}

export async function verifySecondFactor(code: string): Promise<boolean> {
  const u = await getSessionUser();
  if (!u || !u.totpEnabled || !u.totpSecret) return false;
  if (throttled(`mfa:${u.id}`)) return false;
  if (!verifyTotp(decrypt(u.totpSecret), code)) {
    fail(`mfa:${u.id}`);
    return false;
  }
  await logout();
  await startSession(u.id, true);
  return true;
}

export function beginTotpEnrollment(userId: string): string {
  const secret = generateTotpSecret();
  getDb().update(schema.users).set({ totpSecret: encrypt(secret), totpEnabled: false }).where(eq(schema.users.id, userId)).run();
  return secret;
}

export function confirmTotpEnrollment(user: SessionUser, code: string): boolean {
  const fresh = getDb().select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  if (!fresh?.totpSecret) return false;
  if (!verifyTotp(decrypt(fresh.totpSecret), code)) return false;
  getDb().update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, user.id)).run();
  audit(user.householdId, user.id, "auth.totp_enabled");
  return true;
}

export async function changePassword(user: SessionUser, current: string, next: string) {
  if (!(await verify(user.passwordHash, current))) throw new Error("Current password is incorrect.");
  const err = validatePassword(next);
  if (err) throw new Error(err);
  getDb().update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, user.id)).run();
  // Invalidate other sessions.
  getDb().delete(schema.sessions).where(eq(schema.sessions.userId, user.id)).run();
  await startSession(user.id, true);
  audit(user.householdId, user.id, "auth.password_changed");
}
