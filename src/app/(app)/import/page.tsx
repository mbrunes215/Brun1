import { getContext } from "@/server/context";
import { loadAccounts } from "@/server/repo";
import { importFile } from "@/server/actions";
import { ImportForm } from "@/components/ImportForm";
import { Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import type { CsvMapping } from "@/integrations/fileImport";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const ctx = await getContext();
  const accounts = loadAccounts(ctx.householdId).filter((a) => !["real_estate", "vehicle"].includes(a.type));
  const mappings = ((ctx.hh.settings as Record<string, unknown>).csvMappings ?? {}) as Record<string, CsvMapping>;
  return (
    <>
      <PageHeader title="Import transactions" subtitle="For banks SimpleFIN doesn't cover, or to backfill history beyond the 90 days of sync." />
      {accounts.length === 0 ? (
        <Empty title="Add an account first">
          <div className="mt-3"><LinkButton href="/accounts/new" variant="primary">Add account</LinkButton></div>
        </Empty>
      ) : (
        <Card>
          <ImportForm accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} action={importFile} savedMappings={mappings} />
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-muted">
            <li>Re-importing the same file is safe: rows already present are skipped.</li>
            <li>Rows that overlap bank-synced data are flagged as possible duplicates for you to confirm, never silently dropped.</li>
            <li>Your column mapping is remembered per account.</li>
          </ul>
        </Card>
      )}
    </>
  );
}
