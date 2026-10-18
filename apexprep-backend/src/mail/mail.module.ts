import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import type { Env } from '../config/env.schema';
import { MAIL_OUTBOX, MAIL_SMTP, MailService, type MailMessage, type SmtpSender } from './mail.service';

/**
 * The SMTP connection, built only when MAIL_PROVIDER=smtp. Credentials come from the environment and are
 * handed to nodemailer only. Production refuses a cleartext session: without SMTP_SECURE (implicit TLS),
 * STARTTLS is required, so the password is never sent unencrypted.
 */
export function smtpTransport(config: ConfigService<Env, true>): SmtpSender | null {
  if (config.get('MAIL_PROVIDER', { infer: true }) !== 'smtp') return null;
  const user = config.get('SMTP_USER', { infer: true });
  const pass = config.get('SMTP_PASSWORD', { infer: true });
  const secure = config.get('SMTP_SECURE', { infer: true });
  return createTransport({
    host: config.get('SMTP_HOST', { infer: true }),
    port: config.get('SMTP_PORT', { infer: true }),
    secure,
    requireTLS: !secure && config.get('NODE_ENV', { infer: true }) === 'production',
    auth: user && pass ? { user, pass } : undefined,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

@Global()
@Module({
  providers: [
    MailService,
    { provide: MAIL_OUTBOX, useFactory: (): MailMessage[] => [] },
    { provide: MAIL_SMTP, inject: [ConfigService], useFactory: smtpTransport },
  ],
  exports: [MailService, MAIL_OUTBOX],
})
export class MailModule {}
