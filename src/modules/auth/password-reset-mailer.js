import { appendFile } from 'node:fs/promises';
import path from 'node:path';

export function createPasswordResetMailer({ environment, outboxPath = process.env.PASSWORD_RESET_OUTBOX_PATH,
  apiKey = process.env.RESEND_API_KEY, from = process.env.PASSWORD_RESET_FROM_EMAIL } = {}) {
  if (environment !== 'production') {
    const file = path.resolve(outboxPath || '.password-reset-outbox.jsonl');
    return async ({ email, resetUrl, expiresAt }) => {
      await appendFile(file, `${JSON.stringify({ email, resetUrl, expiresAt })}\n`, { mode: 0o600 });
    };
  }
  if (!apiKey || !from) throw new Error('RESEND_API_KEY and PASSWORD_RESET_FROM_EMAIL are required in production');
  return async ({ email, resetUrl }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [email], subject: 'Restablece tu contraseña de Reserva Canchas',
        text: `Para restablecer tu contraseña, abre este enlace (válido durante 30 minutos):\n${resetUrl}\n\nSi no solicitaste el cambio, ignora este mensaje.`,
      }),
    });
    if (!response.ok) throw new Error('Password reset email delivery failed');
  };
}
