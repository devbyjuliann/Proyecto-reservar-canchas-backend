import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import {
  createFacilityMembershipsModule,
  createMySqlFacilityMembershipsAdapter,
} from '../../src/modules/facility-memberships/index.js';
import { createSystemClock } from '../../src/shared/clock.js';

const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const available = process.env.NODE_ENV === 'test'
  && required.every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');

describe('facility memberships MySQL integration', { skip: !available, timeout: 30_000 }, () => {
  let pool;
  let memberships;
  let fixture;

  before(async () => {
    const connection = await createMigrationConnection(loadDatabaseConfig({ forMigrations: true }));
    try { await createMigrator(connection).up(); } finally { await connection.end(); }
    pool = createMySqlPool(loadDatabaseConfig());
    memberships = createFacilityMembershipsModule({
      adapter: createMySqlFacilityMembershipsAdapter({ pool }), clock: createSystemClock(),
    });
  });
  after(async () => { await pool?.end(); });
  beforeEach(async () => { fixture = await seed(pool); });
  afterEach(async () => {
    if (!fixture) return;
    for (const facility of fixture.facilities) {
      await pool.execute('DELETE FROM facility_memberships WHERE facility_id = ?', [facility.id]);
      await pool.execute('DELETE FROM facilities WHERE id = ?', [facility.id]);
    }
    for (const user of fixture.users) {
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [user.id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
    fixture = null;
  });

  const assign = (facility, user) => memberships.assignMembership({
    actor: fixture.admin, facilityId: facility.id, userId: user.id,
  });

  it('assigns multiple owners per facility and one owner to multiple facilities', async () => {
    const [first, second, third] = fixture.facilities;
    const [owner1, owner2] = fixture.owners;
    const [existing] = await pool.execute('SELECT id FROM facility_memberships WHERE facility_id = ?', [first.id]);
    assert.equal(existing.length, 0); // An existing facility is not assigned automatically.
    const m1 = await assign(first, owner1);
    const m2 = await assign(first, owner2);
    await assign(second, owner1);
    assert.notEqual(m1.id, m2.id);
    assert.equal(m1.membershipRole, 'PROPIETARIO');
    assert.equal(m1.createdByUserId, fixture.admin.id);

    const firstPage = await memberships.listMemberships({ actor: fixture.admin, facilityId: first.id, limit: 1 });
    const nextPage = await memberships.listMemberships({
      actor: fixture.admin, facilityId: first.id, limit: 1, cursor: firstPage.page.nextCursor,
    });
    assert.equal(new Set([firstPage.items[0].id, nextPage.items[0].id]).size, 2);
    assert.equal((await memberships.getMembership({
      actor: fixture.admin, facilityId: first.id, membershipId: m1.id,
    })).id, m1.id);
    const ownedPage = await memberships.listOwnedFacilities({ actor: owner1, limit: 1 });
    const ownedNext = await memberships.listOwnedFacilities({
      actor: owner1, limit: 1, cursor: ownedPage.page.nextCursor,
    });
    assert.deepEqual(new Set([ownedPage.items[0].id, ownedNext.items[0].id]), new Set([first.id, second.id]));
    assert.equal((await memberships.listOwnedFacilities({ actor: owner2, limit: 25 })).items.length, 1);
    assert.equal((await memberships.getOwnedFacility({ actor: owner1, facilityId: second.id })).id, second.id);
    await assert.rejects(memberships.getOwnedFacility({ actor: owner1, facilityId: third.id }),
      { code: 'resource_not_found' });
    await assert.rejects(memberships.listOwnedFacilities({ actor: fixture.admin, limit: 25 }), { code: 'forbidden' });
    await assert.rejects(memberships.listOwnedFacilities({ actor: fixture.normal, limit: 25 }), { code: 'forbidden' });
    assert.deepEqual((await memberships.listOwnedFacilities({ actor: fixture.owners[2], limit: 25 })).items, []);
    await assert.rejects(memberships.listMemberships({ actor: owner1, facilityId: first.id, limit: 25 }),
      { code: 'forbidden' });
  });

  it('rejects assignment to a non-owner, inactive user, nonexistent user or facility', async () => {
    const facility = fixture.facilities[0];
    await assert.rejects(assign(facility, fixture.normal), { code: 'membership_conflict' });
    await assert.rejects(assign(facility, { id: '18446744073709551615' }), { code: 'resource_not_found' });
    await assert.rejects(assign({ id: '18446744073709551615' }, fixture.owners[0]), { code: 'resource_not_found' });
    await pool.execute('UPDATE users SET deactivated_at = UTC_TIMESTAMP(6) WHERE id = ?', [fixture.owners[0].id]);
    await assert.rejects(assign(facility, fixture.owners[0]), { code: 'resource_inactive' });
    const [rows] = await pool.execute('SELECT id FROM facility_memberships WHERE facility_id = ?', [facility.id]);
    assert.equal(rows.length, 0);
  });

  it('blocks concurrent active duplicates with a database constraint', async () => {
    const facility = fixture.facilities[0];
    const owner = fixture.owners[0];
    const results = await Promise.allSettled([assign(facility, owner), assign(facility, owner)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'membership_conflict');
    await assert.rejects(pool.execute(
      `INSERT INTO facility_memberships
       (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
       VALUES (?, ?, 'PROPIETARIO', 1, UTC_TIMESTAMP(6), ?)`,
      [facility.id, owner.id, fixture.admin.id],
    ), { code: 'ER_DUP_ENTRY' });
    const [rows] = await pool.execute(
      'SELECT id FROM facility_memberships WHERE facility_id = ? AND user_id = ? AND active = 1',
      [facility.id, owner.id],
    );
    assert.equal(rows.length, 1);
  });

  it('revokes immediately, preserves history and allows a later explicit reassignment', async () => {
    const facility = fixture.facilities[0];
    const owner = fixture.owners[0];
    const first = await assign(facility, owner);
    const revoked = await memberships.revokeMembership({
      actor: fixture.admin, facilityId: facility.id, membershipId: first.id,
    });
    assert.equal(revoked.changed, true);
    assert.equal(revoked.membership.active, false);
    assert.match(revoked.membership.revokedAt, /\.\d{6}Z$/);
    await assert.rejects(memberships.getOwnedFacility({ actor: owner, facilityId: facility.id }),
      { code: 'resource_not_found' });
    assert.deepEqual((await memberships.listOwnedFacilities({ actor: owner, limit: 25 })).items, []);
    const repeated = await memberships.revokeMembership({
      actor: fixture.admin, facilityId: facility.id, membershipId: first.id,
    });
    assert.equal(repeated.changed, false);
    assert.equal(repeated.membership.revokedAt, revoked.membership.revokedAt);

    const second = await assign(facility, owner);
    assert.notEqual(second.id, first.id);
    const [rows] = await pool.execute(
      'SELECT id, active, deactivated_at FROM facility_memberships WHERE facility_id = ? AND user_id = ? ORDER BY id',
      [facility.id, owner.id],
    );
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].active), 0);
    assert.notEqual(rows[0].deactivated_at, null);
    assert.equal(Number(rows[1].active), 1);
    assert.equal(rows[1].deactivated_at, null);
    assert.equal((await memberships.getOwnedFacility({ actor: owner, facilityId: facility.id })).id, facility.id);

    await pool.execute("DELETE FROM user_roles WHERE user_id = ? AND role_code = 'PROPIETARIO'", [owner.id]);
    await assert.rejects(memberships.getOwnedFacility({ actor: owner, facilityId: facility.id }),
      { code: 'resource_not_found' });
  });
});

async function seed(pool) {
  const users = [];
  for (const [name, roles] of [
    ['Administrator', ['USUARIO', 'ADMINISTRADOR']],
    ['Owner One', ['USUARIO', 'PROPIETARIO']],
    ['Owner Two', ['USUARIO', 'PROPIETARIO']],
    ['Owner Without Membership', ['USUARIO', 'PROPIETARIO']],
    ['Regular User', ['USUARIO']],
  ]) {
    const [result] = await pool.execute('INSERT INTO users (name, email) VALUES (?, ?)',
      [name, `${randomUUID()}@membership-integration.test`]);
    const user = { id: String(result.insertId), name, roles };
    users.push(user);
    for (const role of roles) {
      await pool.execute('INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)', [user.id, role]);
    }
  }
  const facilities = [];
  for (let index = 0; index < 3; index += 1) {
    const [result] = await pool.execute(
      "INSERT INTO facilities (name, timezone, minimum_advance_minutes, maximum_advance_minutes) VALUES (?, 'America/Bogota', 15, 43200)",
      [`Membership ${index} ${randomUUID()}`],
    );
    facilities.push({ id: String(result.insertId) });
  }
  return { users, admin: users[0], owners: users.slice(1, 4), normal: users[4], facilities };
}
