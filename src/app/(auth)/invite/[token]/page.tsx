import { redirect } from "next/navigation";
import { ActionForm, Submit, type ActionResult } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { acceptInvite } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  async function accept(_: ActionResult, fd: FormData): Promise<ActionResult> {
    "use server";
    try {
      await acceptInvite(token, { name: String(fd.get("name") || "").trim(), email: String(fd.get("email") || ""), password: String(fd.get("password") || "") });
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Could not accept invite" };
    }
    redirect("/settings/security?welcome=1");
  }
  return (
    <>
      <h1 className="text-lg font-semibold">Join your household</h1>
      <p className="mb-4 mt-1 text-sm text-muted">Create your own login. You'll each see shared finances plus your own accounts.</p>
      <ActionForm action={accept} className="space-y-3">
        <Field label="First name">
          <input name="name" required />
        </Field>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Password" hint="At least 12 characters.">
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </Field>
        <Submit className="w-full">Join</Submit>
      </ActionForm>
    </>
  );
}
