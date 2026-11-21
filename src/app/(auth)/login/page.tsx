import { redirect } from "next/navigation";
import { ActionForm, Submit, type ActionResult } from "@/components/ActionForm";
import { Field } from "@/components/ui";
import { login, userCount } from "@/server/auth";

export const dynamic = "force-dynamic";

async function loginAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  "use server";
  const r = await login(String(fd.get("email") || ""), String(fd.get("password") || ""));
  if (r === "invalid") return { error: "Email or password is incorrect." };
  if (r === "throttled") return { error: "Too many attempts. Try again in 15 minutes." };
  redirect(r === "mfa" ? "/login/2fa" : "/");
}

export default function LoginPage() {
  if (userCount() === 0) redirect("/setup");
  return (
    <>
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      <ActionForm action={loginAction} className="space-y-3">
        <Field label="Email">
          <input name="email" type="email" required autoComplete="username" />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required autoComplete="current-password" />
        </Field>
        <Submit className="w-full">Sign in</Submit>
      </ActionForm>
    </>
  );
}
