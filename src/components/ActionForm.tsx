"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import clsx from "clsx";

export type ActionResult = { error?: string; ok?: string } | undefined;

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [rawState, formAction] = useActionState(action, undefined);
  const state = (rawState ?? undefined) as { error?: string; ok?: string } | undefined;
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {state?.error && <p className="mt-2 text-sm text-bad" role="alert">{state.error}</p>}
      {state?.ok && <p className="mt-2 text-sm text-good" role="status">{state.ok}</p>}
    </form>
  );
}

export function Submit({ children, variant = "primary", className }: { children: ReactNode; variant?: "primary" | "secondary" | "danger"; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={clsx(
        "inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50",
        variant === "primary" && "bg-accent text-white hover:opacity-90",
        variant === "secondary" && "border border-line bg-surface hover:bg-surface-2",
        variant === "danger" && "border border-bad/40 text-bad hover:bg-bad-soft",
        className,
      )}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/** Submits its form whenever the wrapped select/checkbox changes (for inline edits). */
export function AutoSubmit({ action, children, className }: { action: (fd: FormData) => Promise<void>; children: ReactNode; className?: string }) {
  return (
    <form action={action} className={className} onChange={(e) => (e.currentTarget as HTMLFormElement).requestSubmit()}>
      {children}
    </form>
  );
}
