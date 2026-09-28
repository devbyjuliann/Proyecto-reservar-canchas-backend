import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import {
  createMySqlOwnerApplicationsAdapter,
  createOwnerApplicationsModule,
} from '../../src/modules/owner-applications/index.js';
import { createSystemClock } from '../../src/shared/clock.js';

const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const available = process.env.NODE_ENV === 'test'
  && required.every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');

describe('owner applications MySQL integration', { skip: !available, timeout: 30_000 }, () => {
  let pool;
  let ownerApplications;
  let fixture;

  before(async () => {
    const connection = await createMigrationConnection(loadDatabaseConfig({ forMigrations: true }));
    try { await createMigrator(connection).up(); } finally { await connection.end(); }
    pool = createMySqlPool(loadDatabaseConfig());
    ownerApplications = createOwnerApplicationsModule({
      adapter: createMySqlOwnerApplicationsAdapter({ pool }), clock: createSystemClock(),
    });
  });
  after(async () => { await pool?.end(); });
  beforeEach(async () => { fixture = await seed(pool); });
  afterEach(async () => {
    if (!fixture) return;
    await pool.execute('DELETE FROM owner_applications WHERE user_id = ?', [fixture.user.id]);
    for (const actor of [fixture.user, fixture.admin]) {
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [actor.id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [actor.id]);
    }
    fixture = null;
  });

  async function apply() {
    return ownerApplications.create({
      actor: fixture.user, businessName: fixture.businessName, message: 'Dos canchas',
    });
  }

  it('creates pending without a role, rejects duplicate pending and preserves own history', async () => {
    const [first, second] = await Promise.allSettled([apply(), apply()]);
    const results = [first, second];
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'owner_application_pending');
    const initial = results.find((result) => result.status === 'fulfilled').value;
    assert.equal(initial.status, 'PENDIENTE');
    assert.equal(initial.userId, fixture.user.id);
    assert.equal(initial.reviewerUserId, null);
    assert.equal((await roles(pool, fixture.user.id)).join(','), 'USUARIO');

    const [stored] = await pool.execute(
      'SELECT id FROM owner_applications WHERE user_id = ? AND status = ?',
      [fixture.user.id, 'PENDIENTE'],
    );
    assert.equal(stored.length, 1);
    await assert.rejects(pool.execute(
      `INSERT INTO owner_applications
        (user_id, business_name, status, created_at)
       VALUES (?, ?, 'PENDIENTE', UTC_TIMESTAMP(6))`,
      [fixture.user.id, fixture.businessName],
    ), { code: 'ER_DUP_ENTRY' });
    await assert.rejects(ownerApplications.getOwn({
      actor: fixture.admin, applicationId: initial.id,
    }), { code: 'resource_not_found' });

    await ownerApplications.reject({ actor: fixture.admin, applicationId: initial.id, reason: 'Falta información' });
    const replacement = await apply();
    assert.equal(replacement.status, 'PENDIENTE');
    const firstPage = await ownerApplications.listOwn({ actor: fixture.user, limit: 1 });
    const lastPage = await ownerApplications.listOwn({
      actor: fixture.user, limit: 1, cursor: firstPage.page.nextCursor,
    });
    assert.equal(firstPage.items[0].id, replacement.id);
    assert.equal(lastPage.items[0].id, initial.id);
    assert.equal(lastPage.items[0].status, 'RECHAZADA');
    assert.equal(lastPage.page.nextCursor, null);
    const adminPage = await ownerApplications.listAdmin({
      actor: fixture.admin, status: 'PENDIENTE', limit: 25,
    });
    assert.equal(adminPage.items.some((item) => item.id === replacement.id), true);
    assert.equal(adminPage.items.find((item) => item.id === replacement.id).user.email, fixture.user.email);
    const allFirst = await ownerApplications.listAdmin({ actor: fixture.admin, status: 'all', limit: 1 });
    const allSecond = await ownerApplications.listAdmin({
      actor: fixture.admin, status: 'all', limit: 1, cursor: allFirst.page.nextCursor,
    });
    assert.equal(allFirst.items[0].id, replacement.id);
    assert.equal(allSecond.items[0].id, initial.id);
    await assert.rejects(ownerApplications.listAdmin({
      actor: fixture.admin, status: 'all', limit: 25, cursor: firstPage.page.nextCursor,
    }), { code: 'invalid_request' });
  });

  it('rejects with reviewer and reason, without granting PROPIETARIO', async () => {
    const application = await apply();
    await assert.rejects(ownerApplications.approve({
      actor: { ...fixture.user, roles: ['USUARIO', 'ADMINISTRADOR'] },
      applicationId: application.id,
    }), { code: 'forbidden' });
    await assert.rejects(ownerApplications.reject({
      actor: fixture.user, applicationId: application.id, reason: 'No',
    }), { code: 'forbidden' });
    const result = await ownerApplications.reject({
      actor: fixture.admin, applicationId: application.id, reason: 'Falta información',
    });
    assert.equal(result.ownerApplication.status, 'RECHAZADA');
    assert.equal(result.ownerApplication.reviewerUserId, fixture.admin.id);
    assert.match(result.ownerApplication.decidedAt, /\.\d{6}Z$/);
    assert.equal(result.ownerApplication.decisionReason, 'Falta información');
    assert.deepEqual(await roles(pool, fixture.user.id), ['USUARIO']);
    await assert.rejects(ownerApplications.approve({
      actor: fixture.admin, applicationId: application.id,
    }), { code: 'invalid_owner_application_state' });
  });

  it('rejects a new application from a user deactivated after authentication', async () => {
    await pool.execute('UPDATE users SET deactivated_at = UTC_TIMESTAMP(6) WHERE id = ?', [fixture.user.id]);
    await assert.rejects(apply(), { code: 'authentication_required' });
    const [rows] = await pool.execute('SELECT id FROM owner_applications WHERE user_id = ?', [fixture.user.id]);
    assert.equal(rows.length, 0);
  });

  it('approves atomically, grants only PROPIETARIO and creates no facility or membership', async () => {
    const application = await apply();
    const result = await ownerApplications.approve({ actor: fixture.admin, applicationId: application.id });
    assert.equal(result.ownerApplication.status, 'APROBADA');
    assert.equal(result.ownerApplication.reviewerUserId, fixture.admin.id);
    assert.deepEqual(result.user.roles, ['PROPIETARIO', 'USUARIO']);
    assert.deepEqual(await roles(pool, fixture.user.id), ['PROPIETARIO', 'USUARIO']);
    const [facilities] = await pool.execute('SELECT id FROM facilities WHERE name = ?', [fixture.businessName]);
    assert.equal(facilities.length, 0);
    const [memberships] = await pool.execute(
      'SELECT id FROM facility_memberships WHERE user_id = ?', [fixture.user.id],
    );
    assert.equal(memberships.length, 0);
    await assert.rejects(apply(), { code: 'already_owner' });
  });

  it('serializes simultaneous approvals and persists only one owner role', async () => {
    const application = await apply();
    const results = await Promise.allSettled([0, 1].map(() => ownerApplications.approve({
      actor: fixture.admin, applicationId: application.id,
    })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'invalid_owner_application_state');
    const [stored] = await pool.execute(
      'SELECT status, decided_at, decided_by_user_id FROM owner_applications WHERE id = ?',
      [application.id],
    );
    assert.equal(stored[0].status, 'APROBADA');
    assert.notEqual(stored[0].decided_at, null);
    assert.equal(String(stored[0].decided_by_user_id), fixture.admin.id);
    assert.deepEqual(await roles(pool, fixture.user.id), ['PROPIETARIO', 'USUARIO']);
  });

  it('rolls back decision and timestamps if granting the role fails', async () => {
    const application = await apply();
    const failingPool = {
      execute: (...args) => pool.execute(...args),
      async getConnection() {
        const connection = await pool.getConnection();
        return new Proxy(connection, {
          get(target, property) {
            if (property === 'execute') return (sql, values) => {
              if (sql.includes('INSERT INTO user_roles') && values[0] === fixture.user.id) {
                throw new Error('Injected role persistence failure');
              }
              return target.execute(sql, values);
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const failing = createOwnerApplicationsModule({
      adapter: createMySqlOwnerApplicationsAdapter({ pool: failingPool }), clock: createSystemClock(),
    });
    await assert.rejects(failing.approve({ actor: fixture.admin, applicationId: application.id }),
      /Injected role persistence failure/);
    const [stored] = await pool.execute(
      'SELECT status, decided_at, decided_by_user_id, rejection_reason FROM owner_applications WHERE id = ?',
      [application.id],
    );
    assert.equal(stored[0].status, 'PENDIENTE');
    assert.equal(stored[0].decided_at, null);
    assert.equal(stored[0].decided_by_user_id, null);
    assert.equal(stored[0].rejection_reason, null);
    assert.deepEqual(await roles(pool, fixture.user.id), ['USUARIO']);
  });
});

async function seed(pool) {
  const businessName = `Owner Application ${randomUUID()}`;
  const users = [];
  for (const role of ['USUARIO', 'ADMINISTRADOR']) {
    const email = `${randomUUID()}@owner-integration.test`;
    const [result] = await pool.execute('INSERT INTO users (name, email) VALUES (?, ?)', [role, email]);
    const user = { id: String(result.insertId), name: role, email, roles: [role] };
    users.push(user);
    await pool.execute('INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)', [user.id, role]);
  }
  return { user: users[0], admin: users[1], businessName };
}

async function roles(pool, userId) {
  const [rows] = await pool.execute('SELECT role_code FROM user_roles WHERE user_id = ? ORDER BY role_code', [userId]);
  return rows.map((row) => row.role_code);
}
