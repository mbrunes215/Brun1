import QRCode from "qrcode";
import { getContext } from "@/server/context";
import { startTotp, confirmTotp, changePasswordAction } from "@/server/actions";
import { otpauthUri } from "@/server/totp";
import { TotpSetup } from "@/components/TotpSetup";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Card, Field, Notice, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams;
  const ctx = await getContext();
  const email = ctx.user.email;
  async function qr(secret: string) {
    "use server";
    return QRCode.toString(otpauthUri(secret, email), { type: "svg", margin: 0 });
  }
  return (
    <>
      <PageHeader title="Security" />
      {welcome && (
        <div className="mb-4">
          <Notice tone="info">Welcome! Before adding financial data, turn on two-factor authentication. It takes a minute and protects both of you.</Notice>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Two-factor authentication" subtitle="Required for a finance app. Codes come from an authenticator app on your phone.">
          {ctx.user.totpEnabled ? <Notice tone="good">On. You'll be asked for a code at each sign-in.</Notice> : <TotpSetup start={startTotp} confirm={confirmTotp} qr={qr} />}
        </Card>
        <Card title="Change password">
          <ActionForm action={changePasswordAction} className="space-y-3" resetOnSuccess>
            <Field label="Current password"><input type="password" name="current" required autoComplete="current-password" /></Field>
            <Field label="New password" hint="At least 12 characters."><input type="password" name="next" required minLength={12} autoComplete="new-password" /></Field>
            <Submit>Change password</Submit>
          </ActionForm>
        </Card>
      </div>
      {welcome && <p className="mt-4 text-sm"><a className="text-accent underline" href="/">Continue to setup →</a></p>}
    </>
  );
}
