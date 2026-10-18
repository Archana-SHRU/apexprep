import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body; `text` is always sent alongside it as the plain-text part. */
  html?: string;
  /** Machine-readable tag so tests and logs can tell messages apart. */
  kind: 'email_verification' | 'registration_welcome' | 'password_reset';
}

/** String token (not a Symbol) so tests can resolve it from an isolated module registry. */
export const MAIL_OUTBOX = 'apexprep:MAIL_OUTBOX';
/** The SMTP connection (a nodemailer transporter), or null unless MAIL_PROVIDER=smtp. */
export const MAIL_SMTP = 'apexprep:MAIL_SMTP';

/** The nodemailer methods this service uses, so tests can stand in for the SMTP server. */
export interface SmtpSender {
  sendMail(message: { from: { name: string; address: string }; to: string; subject: string; text: string; html?: string }): Promise<unknown>;
  /** Connects and authenticates without sending anything (nodemailer's `verify`). */
  verify?(): Promise<unknown>;
}

/** An error's code and SMTP status only: its message can quote the server's reply, which may echo addresses. */
function safeErrorSummary(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
  return typeof e.responseCode === 'number' ? `code=${code} smtp=${e.responseCode}` : `code=${code}`;
}

/** Links in emails carry single-use bearer tokens: logs show that a link was there, never the token. */
export function redactTokens(text: string): string {
  return text.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]');
}

/**
 * Outgoing email behind one interface. Providers (MAIL_PROVIDER):
 *  - console: logs that an email would be sent, with tokens redacted (development; refused in production)
 *  - memory:  keeps messages in MAIL_OUTBOX (tests read links from it; refused in production)
 *  - smtp:    sends through the SMTP server in SMTP_* (production)
 *  - none:    drops messages
 */
@Injectable()
export class MailService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Mail');
  private readonly provider: Env['MAIL_PROVIDER'];
  private readonly from: { name: string; address: string };
  private readonly smtpTarget: string;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(MAIL_OUTBOX) private readonly outbox: MailMessage[],
    @Inject(MAIL_SMTP) private readonly smtp: SmtpSender | null,
  ) {
    this.provider = config.get('MAIL_PROVIDER', { infer: true });
    this.from = {
      name: config.get('MAIL_FROM_NAME', { infer: true }),
      address: config.get('MAIL_FROM_ADDRESS', { infer: true }) ?? 'no-reply@localhost',
    };
    const secure = config.get('SMTP_SECURE', { infer: true });
    this.smtpTarget = `${config.get('SMTP_HOST', { infer: true }) ?? '?'}:${config.get('SMTP_PORT', { infer: true })} (${secure ? 'implicit TLS' : 'STARTTLS when offered'})`;
  }

  /**
   * Says at startup where email goes, so "the email never arrived" is never a mystery: console mode delivers
   * nothing, and an unreachable SMTP server is reported now rather than at the first send. The check never
   * stops the app from starting, and logs no credentials.
   */
  onApplicationBootstrap(): void {
    switch (this.provider) {
      case 'console':
        this.logger.warn('Mail provider: console — emails are written to this log and NOT delivered. Set MAIL_PROVIDER=smtp to send.');
        return;
      case 'none':
        this.logger.warn('Mail provider: none — emails are dropped.');
        return;
      case 'memory':
        return;
      case 'smtp':
        this.logger.log(`Mail provider: smtp → ${this.smtpTarget}, from ${this.from.address}`);
        this.smtp
          ?.verify?.()
          .then(() => this.logger.log('SMTP server reachable'))
          .catch((err: unknown) => this.logger.warn(`SMTP server not reachable (${safeErrorSummary(err)}); emails will fail until it is`));
    }
  }

  /** Delivers the message; rejects if the provider refuses it. */
  async send(message: MailMessage): Promise<void> {
    switch (this.provider) {
      case 'console':
        this.logger.log(
          `[dev mail, not sent] kind=${message.kind} to=${message.to} subject="${message.subject}"\n${redactTokens(message.text)}`,
        );
        return;
      case 'memory':
        this.outbox.push(message);
        return;
      case 'smtp':
        if (!this.smtp) throw new Error('SMTP transport is not configured');
        await this.smtp.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
        this.logger.log(`Email sent: kind=${message.kind} via smtp`);
        return;
      case 'none':
        return;
    }
  }

  /**
   * Best effort, off the request path: the caller's work is already committed and must not fail or wait
   * because a mail server is slow or down. A failure is logged with the error's code only — never the
   * message body (it may hold a token), the SMTP credentials, or the server's full reply.
   */
  dispatch(message: MailMessage): void {
    this.send(message).catch((err: unknown) => {
      this.logger.warn(`Email delivery failed: kind=${message.kind} provider=${this.provider} ${safeErrorSummary(err)}`);
    });
  }
}
