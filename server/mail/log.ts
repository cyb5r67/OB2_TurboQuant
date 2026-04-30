// Test-only mailer. Writes every outbound email to server/data/mail-log.txt
// and echoes a one-line summary to stdout. Used by tests via OB2_SMTP_DRIVER=log.
//
// Never enable in production — password-reset URLs would be logged in plaintext.

import type { Mailer } from "./mailer.ts";

const LOG_PATH = "../server/data/mail-log.txt";

export class LogMailer implements Mailer {
  isConfigured(): boolean {
    return true;
  }

  async send(msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
    // Refuse to run in what looks like a production deployment. LogMailer writes
    // plaintext reset URLs to disk; if OB2_SMTP_DRIVER=log is left set on a
    // public-internet deployment, every password-reset link becomes recoverable
    // from the data volume.
    const publicUrl = Deno.env.get("OB2_PUBLIC_URL") || "";
    if (publicUrl.startsWith("https://")) {
      let host = "";
      try { host = new URL(publicUrl).hostname; } catch { /* noop */ }
      const isLocal =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
      if (!isLocal) {
        throw new Error(
          "LogMailer refuses to run in production (OB2_PUBLIC_URL is https:// and non-local). " +
          "Set OB2_SMTP_DRIVER=smtp with real SMTP credentials.",
        );
      }
    }

    const line = `[MAIL to=${msg.to} subject=${JSON.stringify(msg.subject)}]`;
    console.log(line);
    const stamp = new Date().toISOString();
    const body =
      `\n===== ${stamp} =====\n` +
      `To: ${msg.to}\n` +
      `Subject: ${msg.subject}\n` +
      `\n--- text ---\n${msg.text}\n` +
      `\n--- html ---\n${msg.html}\n`;
    try {
      await Deno.mkdir("../server/data", { recursive: true });
    } catch { /* already exists */ }
    await Deno.writeTextFile(LOG_PATH, body, { append: true });
  }
}
