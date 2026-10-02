import { appendFile } from 'node:fs/promises';
import path from 'node:path';

// The transport owns delivery; callers own the reason and contents of the message.
export function createEmailTransport({ environment, outboxPath = process.env.PASSWORD_RESET_OUTBOX_PATH,
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.EMAIL_FROM ?? process.env.PASSWORD_RESET_FROM_EMAIL } = {}) {
  if (environment !== 'production') {
    // Preserve the existing local/test outbox location and password-reset test contract.
    const file = path.resolve(outboxPath || '.password-reset-outbox.jsonl');
    return async (message) => {
      await appendFile(file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    };
  }
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY and EMAIL_FROM or PASSWORD_RESET_FROM_EMAIL are required in production');
  }
  return async ({ email, subject, text, html }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject, text, ...(html ? { html } : {}) }),
    });
    if (!response.ok) throw new Error('Email delivery failed');
  };
}
