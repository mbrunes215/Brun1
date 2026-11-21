import Link from "next/link";
import { PageHeader } from "@/components/ui";

const ITEMS: Array<[string, string, string]> = [
  ["/settings/household", "Household", "Names, partner invite, time zone, alert thresholds, retirement assumptions"],
  ["/settings/security", "Security", "Two-factor authentication and password"],
  ["/settings/connections", "Bank connections", "SimpleFIN setup and sync status"],
  ["/settings/income", "Paychecks", "Gross pay and deductions for an accurate savings rate"],
  ["/settings/categories", "Categories", "Groups, budget types, essential vs discretionary"],
  ["/settings/rules", "Rules", "Automatic categorization"],
  ["/settings/data", "Data & backups", "Export everything, backups, contribution limits, audit log"],
];

export default function SettingsIndex() {
  return (
    <>
      <PageHeader title="Settings" />
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {ITEMS.map(([href, title, desc]) => (
          <li key={href}>
            <Link href={href} className="block px-4 py-3 hover:bg-surface-2">
              <div className="text-sm font-medium">{title}</div>
              <div className="text-xs text-muted">{desc}</div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
