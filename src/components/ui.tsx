import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";
import { formatCents } from "@/domain/money";

export function Card({ title, action, children, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-xl border border-line bg-surface", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Money({ cents, sign, className, noCents, colored }: { cents: number; sign?: boolean; className?: string; noCents?: boolean; colored?: boolean }) {
  return (
    <span className={clsx("num", colored && (cents < 0 ? "text-bad" : cents > 0 ? "text-good" : ""), className)}>
      {formatCents(cents, { sign, noCents })}
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={clsx("mt-1 text-2xl font-semibold num", tone === "good" && "text-good", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const btnBase = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50";
export const btn = {
  primary: clsx(btnBase, "bg-accent text-white hover:opacity-90"),
  secondary: clsx(btnBase, "border border-line bg-surface hover:bg-surface-2"),
  ghost: clsx(btnBase, "hover:bg-surface-2"),
  danger: clsx(btnBase, "border border-bad/40 text-bad hover:bg-bad-soft"),
};

export function Button({ variant = "primary", className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof btn }) {
  return <button className={clsx(btn[variant], className)} {...props} />;
}

export function LinkButton({ href, variant = "secondary", children }: { href: string; variant?: keyof typeof btn; children: ReactNode }) {
  return (
    <Link href={href} className={btn[variant]}>
      {children}
    </Link>
  );
}

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info" | "accent"; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "bg-surface-2 text-muted",
        tone === "good" && "bg-good-soft text-good",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "bad" && "bg-bad-soft text-bad",
        tone === "info" && "bg-info-soft text-info",
        tone === "accent" && "bg-accent-soft text-accent",
      )}
    >
      {children}
    </span>
  );
}

export function Progress({ value, max, tone, marker }: { value: number; max: number; tone?: "good" | "warn" | "bad" | "accent"; marker?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const auto = tone ?? (value > max ? "bad" : pct > 90 ? "warn" : "accent");
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={clsx("h-full rounded-full", auto === "good" && "bg-good", auto === "warn" && "bg-warn", auto === "bad" && "bg-bad", auto === "accent" && "bg-accent")}
        style={{ width: `${pct}%` }}
      />
      {marker != null && max > 0 && <div className="absolute top-0 h-full w-0.5 bg-fg/50" style={{ left: `${Math.min(100, (marker / max) * 100)}%` }} title="Expected by today" />}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line p-8 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-1">
      <label>{label}</label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "good"; children: ReactNode }) {
  return (
    <div
      className={clsx(
        "rounded-lg border px-3 py-2 text-sm",
        tone === "info" && "border-info/30 bg-info-soft text-info",
        tone === "warn" && "border-warn/30 bg-warn-soft text-warn",
        tone === "bad" && "border-bad/30 bg-bad-soft text-bad",
        tone === "good" && "border-good/30 bg-good-soft text-good",
      )}
    >
      {children}
    </div>
  );
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function dollarsInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}
