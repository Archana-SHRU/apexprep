import type { MailMessage } from './mail.service';

/**
 * ApexPrep's transactional emails. Every value that comes from a user or a URL goes through `escapeHtml`
 * before it is placed in HTML, so a display name like `<img onerror=…>` arrives as text. Each email has a
 * plain-text twin for clients that do not render HTML. None carries a password, a session token, or an
 * internal id: the only secret is the reset link's one-time token, which is the point of that email.
 */

const BRAND = '#4361EE';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** First name for the greeting; display names are user-supplied, so trimmed and capped. */
function greetingName(displayName: string | null | undefined): string {
  const name = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return name.slice(0, 60);
}

function layout(opts: { preheader: string; heading: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1F2937;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FB;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #E5E7EB;">
      <tr><td style="background:${BRAND};padding:20px 32px;">
        <span style="font-size:22px;font-weight:700;color:#FFFFFF;letter-spacing:0.2px;">ApexPrep</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(opts.heading)}</h1>
        ${opts.body}
      </td></tr>
      <tr><td style="padding:20px 32px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:12px;line-height:1.5;color:#6B7280;">
        ${opts.footer}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function paragraph(html: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${html}</p>`;
}

function button(href: string, label: string): string {
  const url = escapeHtml(href);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:8px;background:${BRAND};">
<a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

function fallbackLink(href: string): string {
  const url = escapeHtml(href);
  return `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6B7280;">If the button does not work, copy this link into your browser:<br><a href="${url}" style="color:${BRAND};word-break:break-all;">${url}</a></p>`;
}

const FOOTER = 'You are receiving this email because of activity on your ApexPrep account. ApexPrep will never ask for your password by email.';

export function registrationWelcomeEmail(input: { to: string; displayName?: string | null; signInUrl: string }): MailMessage {
  const name = greetingName(input.displayName);
  const hello = name ? `Hi ${name},` : 'Hi,';
  const html = layout({
    preheader: 'Your ApexPrep account has been created.',
    heading: 'Welcome to ApexPrep',
    body: [
      paragraph(escapeHtml(hello)),
      paragraph('Your registration was successful and your ApexPrep account has been created.'),
      paragraph('You can now sign in and continue setting up your learning plan.'),
      button(input.signInUrl, 'Sign in to ApexPrep'),
      fallbackLink(input.signInUrl),
    ].join('\n'),
    footer: `${FOOTER} If you did not create this account, you can ignore this email or contact your organisation's ApexPrep administrator.`,
  });
  const text = [
    hello,
    '',
    'Welcome to ApexPrep!',
    '',
    'Your registration was successful and your ApexPrep account has been created.',
    'You can now sign in and continue setting up your learning plan:',
    '',
    input.signInUrl,
    '',
    'If you did not create this account, you can ignore this email.',
    '',
    '— The ApexPrep team',
  ].join('\n');
  return { kind: 'registration_welcome', to: input.to, subject: 'Welcome to ApexPrep — Registration Successful', text, html };
}

export function passwordResetEmail(input: { to: string; displayName?: string | null; resetUrl: string; ttlMinutes: number }): MailMessage {
  const name = greetingName(input.displayName);
  const hello = name ? `Hi ${name},` : 'Hi,';
  const expiry = `This link expires in ${input.ttlMinutes} minutes and can be used only once.`;
  const warning =
    'If you did not request a password reset, you can ignore this email: your password will not change. ' +
    'If you keep receiving these emails, contact your ApexPrep administrator.';
  const html = layout({
    preheader: 'A password reset was requested for your ApexPrep account.',
    heading: 'Reset your password',
    body: [
      paragraph(escapeHtml(hello)),
      paragraph('We received a request to reset the password for your ApexPrep account. Choose a new password using the button below.'),
      button(input.resetUrl, 'Reset password'),
      paragraph(`<strong>${escapeHtml(expiry)}</strong>`),
      fallbackLink(input.resetUrl),
      `<p style="margin:0;padding:12px 16px;font-size:13px;line-height:1.5;background:#FEF3C7;border-radius:8px;color:#92400E;">${escapeHtml(warning)}</p>`,
    ].join('\n'),
    footer: FOOTER,
  });
  const text = [
    hello,
    '',
    'We received a request to reset the password for your ApexPrep account.',
    'Choose a new password here:',
    '',
    input.resetUrl,
    '',
    expiry,
    '',
    warning,
    '',
    '— The ApexPrep team',
  ].join('\n');
  return { kind: 'password_reset', to: input.to, subject: 'Reset your ApexPrep password', text, html };
}
