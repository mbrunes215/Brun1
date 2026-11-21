import "server-only";
import { cookies } from "next/headers";
import { requireUser } from "./auth";
import { getHousehold } from "./repo";
import { todayIn } from "./sync";
import type { OwnerFilter } from "@/domain/ledger";

export const VIEW_COOKIE = "hearth_view";

export async function getContext() {
  const user = await requireUser();
  const hh = getHousehold(user.householdId);
  const raw = (await cookies()).get(VIEW_COOKIE)?.value;
  const view: OwnerFilter = raw === "A" || raw === "B" || raw === "joint" ? raw : "household";
  return {
    user,
    hh,
    householdId: user.householdId,
    names: hh.names,
    viewer: user.slot as "A" | "B",
    view,
    today: todayIn(hh.timezone),
  };
}

export type Ctx = Awaited<ReturnType<typeof getContext>>;
