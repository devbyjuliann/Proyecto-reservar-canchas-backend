import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMySqlBookingAdapter } from '../../../src/modules/booking/mysql-adapter.js';

const NOW = '2026-09-24T14:30:00.000000Z';

function fixture({ facilityInactive = false, protectedBooking = false } = {}) {
  const statements = [];
  let changeId = 500;
  let committed = false;
  let rolledBack = false;
  const connection = {
    async beginTransaction() {},
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
    release() {},
    async execute(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes('FROM facilities WHERE id = ? FOR UPDATE')) {
        return [[{
          id: '3',
          name: 'Centro Deportivo',
          timezone: 'America/Bogota',
          minimum_advance_minutes: 15,
          maximum_advance_minutes: 43_200,
          created_at: '2026-09-01 12:00:00.000000',
          deactivated_at: facilityInactive ? '2026-09-20 12:00:00.000000' : null,
        }]];
      }
      if (sql.includes('FROM courts') && sql.includes('WHERE facility_id = ?')) {
        return [[
          { id: '12', deactivated_at: null },
          { id: '13', deactivated_at: '2026-09-10 12:00:00.000000' },
        ]];
      }
      if (sql.includes('SELECT EXISTS') && sql.includes('FROM bookings')) {
        return [[{ present: protectedBooking ? 1 : 0 }]];
      }
      if (sql.startsWith('UPDATE facilities SET deactivated_at')) return [{ affectedRows: 1 }];
      if (sql.includes('INSERT INTO operational_changes')) {
        changeId += 1;
        return [{ insertId: changeId }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool = {
    execute: (...args) => connection.execute(...args),
    async getConnection() { return connection; },
  };
  return {
    adapter: createMySqlBookingAdapter({ pool }),
    statements,
    state: () => ({ committed, rolledBack }),
  };
}

describe('administrative facility deactivation persistence', () => {
  it('deactivates only the facility and preserves every court row', async () => {
    const { adapter, statements, state } = fixture();
    const result = await adapter.deactivateFacility({
      facilityId: '3',
      actorUserId: '7',
      now: NOW,
    });

    assert.equal(result.operation.changed, true);
    assert.deepEqual(result.operation.changes.map(({ courtId }) => courtId), ['12']);
    assert.equal(result.facility.deactivatedAt, NOW);
    assert.ok(statements.some(({ sql }) => sql.startsWith('UPDATE facilities SET deactivated_at')));
    assert.ok(statements.some(({ sql }) => sql.includes('ORDER BY id ASC FOR UPDATE')));
    assert.ok(!statements.some(({ sql }) => /UPDATE courts SET deactivated_at/.test(sql)));
    assert.deepEqual(state(), { committed: true, rolledBack: false });
  });

  it('returns an unchanged result without touching courts when already inactive', async () => {
    const { adapter, statements } = fixture({ facilityInactive: true });
    const result = await adapter.deactivateFacility({
      facilityId: '3',
      actorUserId: '7',
      now: NOW,
    });

    assert.deepEqual(result.operation, { changed: false, changes: [] });
    assert.equal(result.facility.deactivatedAt, '2026-09-20T12:00:00.000000Z');
    assert.ok(!statements.some(({ sql }) => sql.includes('FROM courts')));
    assert.ok(!statements.some(({ sql }) => sql.startsWith('UPDATE')));
  });

  it('rolls back before any write when a protected booking exists', async () => {
    const { adapter, statements, state } = fixture({ protectedBooking: true });
    await assert.rejects(
      adapter.deactivateFacility({ facilityId: '3', actorUserId: '7', now: NOW }),
      { code: 'future_bookings_prevent_deactivation' },
    );
    assert.ok(!statements.some(({ sql }) => sql.startsWith('UPDATE')));
    assert.ok(!statements.some(({ sql }) => sql.includes('INSERT INTO operational_changes')));
    assert.deepEqual(state(), { committed: false, rolledBack: true });
  });

  it('keeps public availability hidden when the parent facility is inactive', async () => {
    const statements = [];
    const connection = {
      release() {},
      async execute(sql) {
        statements.push(sql);
        if (sql.includes('INNER JOIN facilities')) return [[]];
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const adapter = createMySqlBookingAdapter({
      pool: {
        execute: (...args) => connection.execute(...args),
        async getConnection() { return connection; },
      },
    });
    const result = await adapter.readAvailabilityContext({ courtId: '12', date: '2026-09-28' });
    assert.equal(result, null);
    assert.match(statements[0], /f\.deactivated_at IS NULL/);
  });
});
