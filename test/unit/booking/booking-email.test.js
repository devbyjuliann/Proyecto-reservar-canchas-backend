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

describe('owner booking emails', () => {
  it('uses the booking snapshot, local time and owner bookings CTA for a new booking', async () => {
    const sent = [];
    const notifier = createBookingEmailNotifier({ sendEmail: async (message) => { sent.push(message); },
      frontendOrigin: 'https://canchapp.online' });
    await notifier.ownerConfirmation({ email: 'owner@example.test', customerName: 'Cliente Reserva', booking: BOOKING });
    assert.equal(sent[0].type, 'owner-booking-confirmation');
    assert.equal(sent[0].subject, 'Nueva reserva recibida - Reserva Canchas');
    for (const detail of ['Recibiste una nueva reserva', 'Cliente Reserva', 'La Pista', 'Cancha Norte',
      '10 de octubre de 2026', '18:00 - 19:00', '60 minutos', '$50.000 COP',
      'Estado: Confirmada', 'https://canchapp.online/owner/reservas']) {
      assert.ok(sent[0].text.includes(detail), detail);
    }
    assert.equal(sent[0].text.includes('23:00'), false);
  });

  it('keeps historical booking data for an owner cancellation without promising availability', async () => {
    let message;
    const notifier = createBookingEmailNotifier({ sendEmail: async (value) => { message = value; },
      frontendOrigin: 'https://canchapp.online' });
    await notifier.ownerCancellation({ email: 'owner@example.test', customerName: 'Cliente Reserva', booking: BOOKING });
    assert.equal(message.type, 'owner-booking-cancellation');
    assert.equal(message.subject, 'Reserva cancelada por el cliente - Reserva Canchas');
    for (const detail of ['Un cliente canceló una reserva.', 'Cliente Reserva', '$50.000 COP',
      'Estado: Cancelada', 'El horario vuelve a quedar sujeto a la disponibilidad actual de la cancha.']) {
      assert.ok(message.text.includes(detail), detail);
    }
    assert.equal(message.text.toLowerCase().includes('reembolso'), false);
    assert.equal(message.text.toLowerCase().includes('ya está disponible'), false);
  });
});

describe('booking lifecycle emails', () => {
  it('shows before/after time and price to customer and owner without leaking HTML', async () => {
    const sent = [];
    const notifier = createBookingEmailNotifier({ frontendOrigin: 'https://canchapp.online',
      sendEmail: async (message) => { sent.push(message); } });
    const next = { ...BOOKING, court: { name: '<Cancha Sur>' },
      startAt: '2026-10-11T00:00:00.000000Z', endAt: '2026-10-11T01:00:00.000000Z',
      priceMinor: 6000000 };
    await notifier.reschedule({ email: 'customer@example.test', previous: BOOKING, booking: next });
    await notifier.ownerReschedule({ email: 'owner@example.test', previous: BOOKING, booking: next });
    assert.deepEqual(sent.map((message) => message.subject),
      ['Tu reserva fue modificada - Reserva Canchas', 'Una reserva fue modificada - Reserva Canchas']);
    for (const message of sent) {
      for (const detail of ['18:00', '19:00', '20:00', '$50.000 COP', '$60.000 COP', 'Estado: Confirmada']) {
        assert.ok(message.text.includes(detail), detail);
      }
      assert.ok(message.html.includes('&lt;Cancha Sur&gt;'));
      assert.equal(message.html.includes('<Cancha Sur>'), false);
    }
  });

  it('distinguishes an establishment cancellation from a customer cancellation and notifies exception decision', async () => {
    const sent = [];
    const notifier = createBookingEmailNotifier({ frontendOrigin: 'https://canchapp.online',
      sendEmail: async (message) => { sent.push(message); } });
    await notifier.customerOwnerCancellation({ email: 'customer@example.test', booking: BOOKING,
      reason: 'Daño de Cancha' });
    await notifier.exceptionDecision({ email: 'customer@example.test', booking: BOOKING,
      category: 'MAL_CLIMA', decision: 'APROBADA' });
    assert.ok(sent[0].subject.includes('cancelada por el establecimiento'));
    assert.ok(sent[0].text.includes('Daño de Cancha'));
    assert.ok(sent[0].text.includes('No se ha procesado ninguna devolución'));
    assert.ok(sent[1].text.includes('Mal clima: Aprobada'));
  });
});
