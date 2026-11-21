import { redirect } from "next/navigation";
import { ActionForm, Submit, type ActionResult } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { createOwner, userCount } from "@/server/auth";

export const dynamic = "force-dynamic";

async function setupAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  "use server";
  try {
    await createOwner({
      householdName: String(fd.get("household") || "Our household"),
      name: String(fd.get("name") || "").trim(),
      partnerName: String(fd.get("partner") || "").trim() || "Partner",
      email: String(fd.get("email") || ""),
      password: String(fd.get("password") || ""),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Setup failed" };
  }
  redirect("/settings/security?welcome=1");
}

export default function SetupPage() {
  if (userCount() > 0) redirect("/login");
  return (
    <>
      <h1 className="text-lg font-semibold">Set up your household</h1>
      <p className="mb-4 mt-1 text-sm text-muted">You'll invite your partner next. Each of you gets your own login.</p>
      <ActionForm action={setupAction} className="space-y-3">
        <Field label="Household name">
          <input name="household" placeholder="The Smiths" required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Your first name">
            <input name="name" required autoComplete="given-name" />
          </Field>
          <Field label="Partner's first name">
            <input name="partner" required />
          </Field>
        </div>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Password" hint="At least 12 characters. A passphrase works well.">
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </Field>
        <Submit className="w-full">Create household</Submit>
      </ActionForm>
    </>
  );
}
