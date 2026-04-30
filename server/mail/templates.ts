// Email body templates. Each exported function returns a triple
// { subject, text, html } suitable for direct consumption by Mailer.send.
//
// HTML is intentionally minimal: inline styles only, no external assets, no
// tracking pixels, no logos. A single centered container with a button-styled
// anchor link.

interface EmailTriple {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlShell(bodyInner: string): string {
  return `<!DOCTYPE html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;background:#f4f4f6;margin:0;padding:24px">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e5e9;border-radius:8px;padding:24px;color:#1c1c1e">
${bodyInner}
</div>
</body></html>`;
}

function htmlButton(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${escapeHtml(label)}</a>`;
}

export function renderResetEmail(args: {
  username: string;
  url: string;
  ttlHours: number;
}): EmailTriple {
  const subject = "OB2 password reset";
  const text =
    `Hi ${args.username},\n\n` +
    `Someone requested a password reset for your OB2 account. If it was you, follow this link to choose a new password:\n\n` +
    `  ${args.url}\n\n` +
    `This link expires in ${args.ttlHours} hour${args.ttlHours === 1 ? "" : "s"} and can only be used once.\n\n` +
    `If you did not request this, you can safely ignore this email.\n`;
  const html = htmlShell(
    `<h2 style="margin-top:0">OB2 password reset</h2>` +
    `<p>Hi <strong>${escapeHtml(args.username)}</strong>,</p>` +
    `<p>Someone requested a password reset for your OB2 account. If it was you, click the button below to choose a new password.</p>` +
    `<p style="text-align:center;margin:24px 0">${htmlButton("Reset password", args.url)}</p>` +
    `<p style="color:#6a6a72;font-size:13px">Link expires in ${args.ttlHours} hour${args.ttlHours === 1 ? "" : "s"} and can only be used once.</p>` +
    `<p style="color:#6a6a72;font-size:13px">If you did not request this, ignore this email.</p>`
  );
  return { subject, text, html };
}

export function renderInviteEmail(args: {
  username: string;
  url: string;
  ttlDays: number;
}): EmailTriple {
  const subject = "You've been invited to OB2";
  const text =
    `An administrator has created an OB2 account for you (${args.username}).\n\n` +
    `Follow this link to set your password and sign in:\n\n` +
    `  ${args.url}\n\n` +
    `This link expires in ${args.ttlDays} day${args.ttlDays === 1 ? "" : "s"} and can only be used once.\n`;
  const html = htmlShell(
    `<h2 style="margin-top:0">You've been invited to OB2</h2>` +
    `<p>An administrator created an OB2 account for you (<strong>${escapeHtml(args.username)}</strong>).</p>` +
    `<p>Click below to set your password and sign in.</p>` +
    `<p style="text-align:center;margin:24px 0">${htmlButton("Set password", args.url)}</p>` +
    `<p style="color:#6a6a72;font-size:13px">Link expires in ${args.ttlDays} day${args.ttlDays === 1 ? "" : "s"}.</p>`
  );
  return { subject, text, html };
}

export function renderSmtpTestEmail(): EmailTriple {
  const subject = "OB2 SMTP test";
  const text = `If you received this, OB2 can reach your SMTP server.\n`;
  const html = htmlShell(
    `<h2 style="margin-top:0">OB2 SMTP test</h2>` +
    `<p>If you received this, OB2 can reach your SMTP server.</p>`
  );
  return { subject, text, html };
}
