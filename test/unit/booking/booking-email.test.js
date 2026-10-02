import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBookingEmailNotifier } from '../../../src/modules/booking/booking-email.js';

const BOOKING = {
  court: { name: 'Cancha Norte' }, facility: { name: 'La Pista' },
  startAt: '2026-10-10T23:00:00.000000Z', endAt: '2026-10-11T00:00:00.000000Z',
  timeZone: 'America/Bogota', priceMinor: 5000000, currency: 'COP',
};

describe('client booking emails', () => {
  it('uses the booking snapshot and local time in text and escaped HTML', async () => {
    const sent = [];
    const notifier = createBookingEmailNotifier({ sendEmail: async (message) => { sent.push(message); },
      frontendOrigin: 'https://canchapp.online' });
    await notifier.confirmation({ email: 'cliente@example.test', booking: BOOKING });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'booking-confirmation');
    assert.equal(sent[0].email, 'cliente@example.test');
    assert.equal(sent[0].subject, 'Reserva confirmada - Reserva Canchas');
    for (const detail of ['La Pista', 'Cancha Norte', '10 de octubre de 2026', '18:00 - 19:00',
      '60 minutos', '$50.000 COP', 'Estado: Confirmada', 'https://canchapp.online/reservas']) {
      assert.ok(sent[0].text.includes(detail), detail);
    }
    assert.ok(sent[0].html.includes('Reserva confirmada'));
    assert.ok(sent[0].html.includes('$50.000 COP'));
    assert.equal(sent[0].text.includes('23:00'), false);
  });

  it('keeps the historical price on cancellation and has a no-price fallback', async () => {
    const sent = [];
    const notifier = createBookingEmailNotifier({ sendEmail: async (message) => { sent.push(message); },
      frontendOrigin: 'https://canchapp.online' });
    await notifier.cancellation({ email: 'cliente@example.test', booking: BOOKING });
    assert.equal(sent[0].subject, 'Reserva cancelada - Reserva Canchas');
    assert.ok(sent[0].text.includes('$50.000 COP'));
    assert.ok(sent[0].text.includes('Estado: Cancelada'));
    assert.ok(sent[0].text.includes('La reserva permanecerá disponible en tu historial.'));
    assert.equal(sent[0].text.toLowerCase().includes('reembolso'), false);
    await notifier.cancellation({ email: 'cliente@example.test', booking: { ...BOOKING, priceMinor: null, currency: null } });
    assert.ok(sent[1].text.includes('Precio no disponible'));
  });

  it('escapes user-provided resource names in HTML', async () => {
    let message;
    const notifier = createBookingEmailNotifier({ sendEmail: async (value) => { message = value; },
      frontendOrigin: 'https://canchapp.online' });
    await notifier.confirmation({ email: 'cliente@example.test', booking: {
      ...BOOKING, court: { name: '<script>test</script>' },
    } });
    assert.ok(message.text.includes('<script>test</script>'));
    assert.ok(message.html.includes('&lt;script&gt;test&lt;/script&gt;'));
    assert.equal(message.html.includes('<script>'), false);
  });
});
