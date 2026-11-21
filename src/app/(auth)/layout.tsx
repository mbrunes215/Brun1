export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <img src="/icon.svg" alt="" className="h-8 w-8" />
        <span className="text-lg font-semibold">Hearth</span>
      </div>
      <div className="rounded-xl border border-line bg-surface p-6">{children}</div>
      <p className="mt-6 text-center text-xs text-muted">Self-hosted. Your data stays on your server.</p>
    </main>
  );
}
