import assert from 'node:assert/strict';
import test from 'node:test';

import { localDayBounds } from '../../../src/shared/time.js';

test('local day bounds use the first real instant when midnight is skipped', () => {
  assert.deepEqual(localDayBounds('2026-09-06', 'America/Santiago'), {
    startAt: '2026-09-06 04:00:00.000000',
    endAt: '2026-09-07 03:00:00.000000',
  });
});
