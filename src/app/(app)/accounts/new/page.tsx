import { getContext } from "@/server/context";
import { loadAccounts } from "@/server/repo";
import { AccountForm } from "@/components/AccountForm";
import { Card, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewAccount() {
  const ctx = await getContext();
  const assets = loadAccounts(ctx.householdId).filter((a) => a.type === "real_estate" || a.type === "vehicle");
  return (
    <>
      <PageHeader title="Add a manual account" subtitle="For your home, cars, loans, or any account SimpleFIN can't reach. Update balances monthly during your close." />
      <Card>
        <AccountForm names={ctx.names} assets={assets} />
      </Card>
    </>
  );
}
