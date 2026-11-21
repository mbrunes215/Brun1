import Link from "next/link";
import { NAV } from "@/components/navItems";
import { PageHeader } from "@/components/ui";

export default function MorePage() {
  return (
    <>
      <PageHeader title="More" />
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {NAV.filter((n) => !["/", "/transactions", "/budget", "/accounts"].includes(n.href)).map((n) => (
          <li key={n.href}><Link href={n.href} className="block px-4 py-3 text-sm">{n.label}</Link></li>
        ))}
        <li><Link href="/alerts" className="block px-4 py-3 text-sm">Alerts</Link></li>
        <li><Link href="/import" className="block px-4 py-3 text-sm">Import transactions</Link></li>
      </ul>
    </>
  );
}
