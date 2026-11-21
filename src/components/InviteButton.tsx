"use client";

import { useActionState } from "react";
import type { ActionResult } from "./ActionForm";

export function InviteButton({ action }: { action: (prev: ActionResult) => Promise<ActionResult> }) {
  const [s, run] = useActionState(action, undefined);
  const link = s?.ok ? `${typeof window !== "undefined" ? window.location.origin : ""}${s.ok}` : null;
  return (
    <div className="space-y-2">
      <form action={run}>
        <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">Create invite link</button>
      </form>
      {link && (
        <div className="space-y-1">
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="text-xs" />
          <p className="text-xs text-muted">Send this privately (text or in person). It works once and expires in 7 days.</p>
        </div>
      )}
    </div>
  );
}
