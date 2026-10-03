import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { copToMinor, wompiAmountInCentsFromMinor } from '../../src/modules/payments/money.js';
import { sha256, verifyWebhookSignature } from '../../src/modules/payments/wompi.js';
import { createBookingModule } from '../../src/modules/booking/booking.js';

describe('Wompi sandbox primitives', () => {
  it('uses Reserva COP minor units as Wompi amount_in_cents without scaling', () => {
    assert.equal(copToMinor(1000), 100000);
    assert.equal(copToMinor(50000), 5000000);
    assert.equal(wompiAmountInCentsFromMinor(100000), 100000);
  });

  it('verifies ordered, dynamic signature properties and rejects a tampered field', () => {
    const event = { timestamp: 1700000000, data: { transaction: { id: 'tx_1', amount_in_cents: 100000 } },
      signature: { properties: ['transaction.id', 'transaction.amount_in_cents'] } };
    event.signature.checksum = sha256('tx_11000001700000000event_secret');
    assert.equal(verifyWebhookSignature({ event, eventsSecret: 'event_secret' }), true);
    event.data.transaction.amount_in_cents = 100001;
    assert.equal(verifyWebhookSignature({ event, eventsSecret: 'event_secret' }), false);
  });
});

describe('Wompi settlement notifications', () => {
  for (const status of ['DECLINED', 'ERROR']) {
    it(`does not send confirmation for a settled ${status} transaction`, async () => {
      let confirmations = 0;
      let received;
      const booking = createBookingModule({
        adapter: { async settlePayment(input) { received = input; return { changed: true, confirmed: false }; } },
        clock: { now: () => '2026-09-24T14:30:00.000Z' },
        notifications: { confirmation: async () => { confirmations += 1; } },
      });
      const facts = { id: 'tx_1', status };
      await booking.settlePayment({ provider: 'WOMPI', facts });
      assert.deepEqual(received, { provider: 'WOMPI', facts });
      assert.equal(confirmations, 0);
    });
  }
});
