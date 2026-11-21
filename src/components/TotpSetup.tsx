"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionResult } from "./ActionForm";

export function TotpSetup({
  start,
  confirm,
  qr,
}: {
  start: (prev: ActionResult) => Promise<ActionResult>;
  confirm: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  qr: (secret: string) => Promise<string>;
}) {
  const [s, startAction] = useActionState(start, undefined);
  const [c, confirmAction] = useActionState(confirm, undefined);
  const secret = s?.ok;
  return (
    <div className="space-y-3">
      {!secret ? (
        <form action={startAction}>
          <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">Set up two-factor</button>
        </form>
      ) : (
        <>
          <QrBlock secret={secret} qr={qr} />
          <form action={confirmAction} className="flex items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="code">6-digit code from your app</label>
              <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" className="!w-40" />
            </div>
            <button className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">Turn on</button>
          </form>
          {c?.error && <p className="text-sm text-bad">{c.error}</p>}
          {c?.ok && <p className="text-sm text-good">{c.ok}</p>}
        </>
      )}
    </div>
  );
}

function QrBlock({ secret, qr }: { secret: string; qr: (s: string) => Promise<string> }) {
  const [svg, setSvg] = useState<string>("");
  useEffect(() => {
    qr(secret).then(setSvg);
  }, [secret, qr]);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="h-40 w-40 rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="text-sm">
        <p>Scan with 1Password, Google Authenticator, Authy, or your phone's password manager.</p>
        <p className="mt-2 text-xs text-muted">Can't scan? Enter this key:</p>
        <code className="break-all text-xs">{secret.match(/.{1,4}/g)?.join(" ")}</code>
      </div>
    </div>
  );
}
