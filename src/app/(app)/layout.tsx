import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { BottomNav, SideNav } from "@/components/Nav";
import { getContext, VIEW_COOKIE } from "@/server/context";
import { getDb, schema } from "@/db";
import { logout } from "@/server/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

async function setView(fd: FormData) {
  "use server";
  const v = String(fd.get("view") || "household");
  (await cookies()).set(VIEW_COOKIE, v, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
}

async function signOut() {
  "use server";
  await logout();
  redirect("/login");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const db = getDb();
  const unreviewed = db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.householdId, ctx.householdId), isNull(schema.transactions.reviewedAt), eq(schema.transactions.isHidden, false)))
    .all().length;
  const unreadAlerts = db
    .select({ id: schema.alerts.id })
    .from(schema.alerts)
    .where(and(eq(schema.alerts.householdId, ctx.householdId), isNull(schema.alerts.readAt)))
    .all().length;

  const viewSelect = (
    <form action={setView} className="flex items-center gap-2">
      <label htmlFor="view" className="sr-only">View</label>
      <select id="view" name="view" defaultValue={ctx.view} className="!w-auto !py-1 text-sm">
        <option value="household">Household</option>
        <option value="A">{ctx.names.A}</option>
        <option value="B">{ctx.names.B}</option>
        <option value="joint">Joint only</option>
      </select>
      <button className="rounded-lg border border-line px-2 py-1 text-xs hover:bg-surface-2">Apply</button>
    </form>
  );

  return (
    <div className="lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 lg:flex">
        <div className="mb-4 flex items-center gap-2 px-2">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <span className="font-semibold">{ctx.hh.name}</span>
        </div>
        <SideNav badges={{ "/transactions": unreviewed }} />
        <div className="mt-auto space-y-2 border-t border-line px-2 pt-3 text-xs text-muted">
          <div>Signed in as {ctx.user.name}</div>
          <form action={signOut}>
            <button className="hover:text-fg">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-bg/90 px-4 py-2 backdrop-blur lg:px-8">
          <a href="/" className="flex items-center gap-2 lg:hidden">
            <img src="/icon.svg" alt="" className="h-6 w-6" />
            <span className="font-semibold">Hearth</span>
          </a>
          <div className="hidden text-sm text-muted lg:block">Viewing: {ctx.view === "household" ? "Household" : ctx.view === "joint" ? "Joint" : ctx.names[ctx.view]}</div>
          <div className="flex items-center gap-3">
            <a href="/alerts" className="relative text-sm text-muted hover:text-fg" aria-label="Alerts">
              Alerts
              {unreadAlerts > 0 && <span className="ml-1 rounded-full bg-bad px-1.5 text-[10px] font-semibold text-white">{unreadAlerts}</span>}
            </a>
            {viewSelect}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-6 lg:px-8 lg:pb-10">{children}</main>
      </div>
      <BottomNav />
    </div>
  );
}
