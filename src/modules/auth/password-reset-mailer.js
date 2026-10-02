import { createEmailTransport } from '../../shared/email-transport.js';

export function createPasswordResetMailer({ environment, outboxPath = process.env.PASSWORD_RESET_OUTBOX_PATH,
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.EMAIL_FROM ?? process.env.PASSWORD_RESET_FROM_EMAIL, sendEmail } = {}) {
  const transport = sendEmail ?? createEmailTransport({ environment, outboxPath, apiKey, from });
  return async ({ email, resetUrl, expiresAt }) => {
    await transport({
      type: 'password-reset', email, resetUrl, expiresAt,
      subject: 'Restablece tu contraseña de Reserva Canchas',
      text: `Para restablecer tu contraseña, abre este enlace (válido durante 30 minutos):\n${resetUrl}\n\nSi no solicitaste el cambio, ignora este mensaje.`,
    });
  };
}
