"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { NAV } from "./navItems";



const MOBILE = ["/", "/transactions", "/budget", "/accounts", "/more"];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function active(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function SideNav({ badges }: { badges?: Record<string, number> }) {
  const path = usePathname();
  return (
    <nav className="space-y-0.5">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={clsx(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm",
            active(path, n.href) ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
          )}
        >
          <Icon d={n.icon} />
          <span className="flex-1">{n.label}</span>
          {badges?.[n.href] ? <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">{badges[n.href]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function BottomNav() {
  const path = usePathname();
  const items = MOBILE.map((h) => (h === "/more" ? { href: "/more", label: "More", icon: "M5 12h.01M12 12h.01M19 12h.01" } : NAV.find((n) => n.href === h)!));
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      {items.map((n) => (
        <Link key={n.href} href={n.href} className={clsx("flex flex-col items-center gap-0.5 py-2 text-[11px]", active(path, n.href) ? "text-accent" : "text-muted")}>
          <Icon d={n.icon} />
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
