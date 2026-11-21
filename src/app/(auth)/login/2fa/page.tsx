import { redirect } from "next/navigation";
import { ActionForm, Submit, type ActionResult } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { getSessionUser, verifySecondFactor } from "@/server/auth";

export const dynamic = "force-dynamic";

async function verifyAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  "use server";
  if (!(await verifySecondFactor(String(fd.get("code") || "")))) return { error: "That code didn't work. Check your authenticator app's time." };
  redirect("/");
}

export default async function TwoFactorPage() {
  const u = await getSessionUser();
  if (!u) redirect("/login");
  if (u.mfaPassed) redirect("/");
  return (
    <>
      <h1 className="text-lg font-semibold">Two-factor code</h1>
      <p className="mb-4 mt-1 text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
      <ActionForm action={verifyAction} className="space-y-3">
        <Field label="Code">
          <input name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required autoFocus />
        </Field>
        <Submit className="w-full">Verify</Submit>
      </ActionForm>
    </>
  );
}
