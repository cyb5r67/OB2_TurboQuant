// Production SMTP driver. Wraps denomailer for RFC-5321 transport.
//
// Connection lifecycle: open-per-send. For password-reset volume (≪1/sec) this
// is fine. If volume ever grows, introduce a persistent client here — interface
// is unchanged.
//
// Reads SMTP config from runtime_config on every send, so admin-UI edits (or
// config.yaml hot-reload) take effect immediately — no restart.

import { SMTPClient } from "denomailer";
import { getRuntime } from "../runtime_config.ts";
import type { Mailer } from "./mailer.ts";

export class SmtpMailer implements Mailer {
  // "Can the SMTP transport actually send a message?" — host + from are the
  // bare minimum. public_url is NOT checked here because it's only needed for
  // building invite/reset URLs, not for raw transport. Callers that need a
  // URL (forgot-password, /admin/users/:u/invite) check public_url separately.
  isConfigured(): boolean {
    const m = getRuntime().mail;
    return !!(m.host && m.from);
  }

  async send(msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const m = getRuntime().mail;
    if (!this.isConfigured()) {
      throw new Error("SmtpMailer: missing host or from");
    }

    const hasAuth = !!(m.user && m.pass);

    // denomailer's tls dispatch:
    //   - "tls"      → direct TLS (port 465 typical)
    //   - "starttls" → connect plaintext, upgrade via STARTTLS (port 587 typical)
    //   - "none"     → plaintext, no upgrade (local dev / MailHog only)
    const client = new SMTPClient({
      connection: {
        hostname: m.host,
        port: m.port,
        tls: m.secure === "tls",
        auth: hasAuth
          ? { username: m.user, password: m.pass }
          : undefined,
      },
      ...(m.secure === "none"
        ? { debug: { allowUnsecure: true, noStartTLS: true } }
        : {}),
    });

    try {
      await client.send({
        from: m.from,
        to: msg.to,
        subject: msg.subject,
        content: msg.text,
        html: msg.html,
      });
    } finally {
      await client.close();
    }
  }
}
