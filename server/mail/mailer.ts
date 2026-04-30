// Mailer interface + driver dispatch.
//
// Drivers currently shipped:
//   - SmtpMailer: production RFC-5321 SMTP via denomailer.
//   - LogMailer:  test-only — writes outbound mail to server/data/mail-log.txt.
//
// Adding a provider-specific HTTP driver (Sendgrid, SES, Mailgun) means a new
// file under server/mail/ and a new case in getMailer().
//
// This module does NOT cache a singleton Mailer — it resolves fresh on every
// getMailer() call based on the current runtime config. Editing SMTP settings
// in config.yaml (or via the admin UI) takes effect on the next outbound send,
// no restart needed.

import { getRuntime } from "../runtime_config.ts";
import { LogMailer } from "./log.ts";
import { SmtpMailer } from "./smtp.ts";

export interface Mailer {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
  isConfigured(): boolean;
}

/** No-op kept for backwards compatibility with server/index.ts boot wiring;
 * driver resolution happens lazily on getMailer() now. */
export function initMailer(): void {
  // intentional no-op
}

/** Returns a freshly-resolved Mailer reflecting the current runtime config,
 * or null if no driver is configured. Callers should null-check and typically
 * return 503/400 to the client when no mailer is available. */
export function getMailer(): Mailer | null {
  const m = getRuntime().mail;
  if (m.driver === "log") return new LogMailer();
  if (m.driver === "smtp" || m.host) return new SmtpMailer();
  return null;
}
