import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import { createFacilitiesModule, createMySqlFacilitiesAdapter } from '../../src/modules/facilities/index.js';
import { createFacilityMembershipsModule, createMySqlFacilityMembershipsAdapter } from '../../src/modules/facility-memberships/index.js';
import { createMySqlPublicCatalogAdapter, createPublicCatalogModule } from '../../src/modules/public-catalog/index.js';
import { createSystemClock } from '../../src/shared/clock.js';

const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const available = process.env.NODE_ENV === 'test'
  && required.every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');

describe('public catalog MySQL integration', { skip: !available, timeout: 30_000 }, () => {
  let pool;
  let adapter;
  let catalog;
  let facilities;
  let memberships;
  let fixture;
  let legacyId;

  before(async () => {
    const connection = await createMigrationConnection(loadDatabaseConfig({ forMigrations: true }));
    try {
      const migrator = createMigrator(connection);
      if ((await migrator.pending()).some(({ name }) => name === '011-add-marketplace-catalog.js')) {
        const [legacy] = await connection.execute(
          `INSERT INTO facilities (name, timezone, minimum_advance_minutes, maximum_advance_minutes)
           VALUES (?, 'America/Bogota', 15, 43200)`, [`Legacy ${randomUUID()}`],
        );
        legacyId = String(legacy.insertId);
      }
      await migrator.up();
    } finally {
      await connection.end();
    }
    pool = createMySqlPool(loadDatabaseConfig());
    adapter = createMySqlPublicCatalogAdapter({ pool });
    catalog = createPublicCatalogModule({ adapter, clock: createSystemClock() });
    facilities = createFacilitiesModule({ adapter: createMySqlFacilitiesAdapter({ pool }), clock: createSystemClock() });
    memberships = createFacilityMembershipsModule({
      adapter: createMySqlFacilityMembershipsAdapter({ pool }), clock: createSystemClock(),
    });
  });

  after(async () => {
    if (pool && legacyId) await pool.execute('DELETE FROM facilities WHERE id = ?', [legacyId]);
    await pool?.end();
  });
  beforeEach(async () => { fixture = await seed(pool); });
  afterEach(async () => {
    if (!fixture) return;
    for (const court of fixture.courts) {
      await pool.execute('DELETE FROM court_prices WHERE court_id = ?', [court.id]);
      await pool.execute('DELETE FROM court_allowed_durations WHERE court_id = ?', [court.id]);
      await pool.execute('DELETE FROM courts WHERE id = ?', [court.id]);
    }
    for (const facility of fixture.facilities) {
      await pool.execute('DELETE FROM facility_memberships WHERE facility_id = ?', [facility.id]);
      await pool.execute('DELETE FROM facilities WHERE id = ?', [facility.id]);
    }
    for (const user of [fixture.admin, fixture.owner]) {
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [user.id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
    fixture = null;
  });

  const filters = (values = {}) => ({ q: null, city: null, sport: null, ...values });

  it('leaves historical and newly created facilities unpublished', async () => {
    if (legacyId) {
      const [legacy] = await pool.execute(
        'SELECT publication_status, published_at, city FROM facilities WHERE id = ?', [legacyId],
      );
      assert.equal(legacy[0].publication_status, 'DRAFT');
      assert.equal(legacy[0].published_at, null);
      assert.equal(legacy[0].city, null);
    }
    const [rows] = await pool.execute(
      'SELECT publication_status, published_at, deactivated_at FROM facilities WHERE id = ?',
      [fixture.facilities[0].id],
    );
    assert.equal(rows[0].publication_status, 'DRAFT');
    assert.equal(rows[0].published_at, null);
    assert.equal(rows[0].deactivated_at, null);
    assert.deepEqual((await catalog.listFacilities({ filters: filters(), limit: 25 })).items, []);
    await assert.rejects(catalog.getFacility(fixture.facilities[0].id), { code: 'resource_not_found' });
  });

  it('allows an Administrator to prepare description and sport, but blocks publication until price exists', async () => {
    const facility = fixture.facilities[0];
    const court = fixture.courts[0];
    const result = await facilities.updateFacility({
      actor: fixture.admin, facilityId: facility.id, city: '  Bogotá  ',
      address: '  Calle 1  ', description: '  Canchas cubiertas  ',
    });
    assert.equal(result.facility.city, 'Bogotá');
    assert.equal(result.facility.publicationState, 'DRAFT');
    const courtResult = await facilities.updateCourt({
      actor: fixture.admin, courtId: court.id, sportCode: 'FUTBOL_5', description: 'Cubierta',
    });
    assert.equal(courtResult.court.sportCode, 'FUTBOL_5');
    const own = await memberships.getOwnedFacility({ actor: fixture.owner, facilityId: facility.id });
    assert.equal(own.city, 'Bogotá');
    assert.equal(own.publicationState, 'DRAFT');

    await assert.rejects(catalog.publish({ actor: fixture.owner, facilityId: facility.id }),
      { code: 'forbidden' });
    await assert.rejects(catalog.publish({ actor: fixture.admin, facilityId: fixture.facilities[2].id }),
      { code: 'facility_not_publishable' }); // Inactive.
    await assert.rejects(catalog.publish({ actor: fixture.admin, facilityId: facility.id }),
      { code: 'facility_not_publishable' }); // Price does not exist in 011.
    const [rows] = await pool.execute('SELECT publication_status, published_at FROM facilities WHERE id = ?',
      [facility.id]);
    assert.equal(rows[0].publication_status, 'DRAFT');
    assert.equal(rows[0].published_at, null);
    assert.deepEqual((await catalog.listCourts({ filters: filters(), limit: 25 })).items, []);
    await assert.rejects(catalog.getCourt(court.id), { code: 'resource_not_found' });
  });

  it('filters public candidates by city, sport, text and price without exposing inactive resources', async () => {
    const [main, other, inactive] = fixture.facilities;
    for (const facility of [main, other, inactive]) {
      await pool.execute(
        `UPDATE facilities SET publication_status = 'PUBLISHED',
           published_at = UTC_TIMESTAMP(6), published_by_user_id = ? WHERE id = ?`,
        [fixture.admin.id, facility.id],
      );
    }
    assert.equal(await catalog.isCourtVisible(fixture.courts[0].id), false);
    await assert.rejects(catalog.getCourt(fixture.courts[0].id), { code: 'resource_not_found' });
    for (const [index, court] of fixture.courts.entries()) {
      await pool.execute(
        `INSERT INTO court_prices (court_id, duration_minutes, price_amount_minor, currency)
         VALUES (?, 60, ?, 'COP')`, [court.id, index === 1 ? 12000000 : 9000000],
      );
    }
    const base = { kind: 'facilities', limit: 25, position: null };
    const cityRows = await adapter.list({ ...base, filters: filters({ city: 'bogotá', sport: 'FUTBOL_5' }) });
    assert.deepEqual(cityRows.map((row) => row.id), [main.id]);
    const nameRows = await adapter.list({ ...base, filters: filters({ q: fixture.courts[0].name }) });
    assert.deepEqual(nameRows.map((row) => row.id), [main.id]);
    const sportRows = await adapter.list({ ...base, filters: filters({ sport: 'BASKET' }) });
    assert.deepEqual(sportRows.map((row) => row.id), [other.id]);
    const courtRows = await adapter.list({ kind: 'courts', facilityId: null,
      filters: filters({ city: 'bogotá', sport: 'FUTBOL_5' }), limit: 25, position: null });
    assert.deepEqual(courtRows.map((row) => row.id), [fixture.courts[0].id]);
    assert.equal(courtRows[0].membershipRole, undefined);
    assert.equal(courtRows[0].publishedByUserId, undefined);
    const scoped = await adapter.list({ kind: 'facility-courts', facilityId: main.id,
      filters: filters({ sport: 'FUTBOL_5' }), limit: 25, position: null });
    assert.deepEqual(scoped.map((row) => row.id), [fixture.courts[0].id]);
    assert.equal(await catalog.isCourtVisible(fixture.courts[0].id), true);
    const filtered = await catalog.listFacilities({ filters: filters({
      city: 'bogotá', sport: 'FUTBOL_5', minPriceMinor: 8000000, maxPriceMinor: 9500000,
    }), limit: 25 });
    assert.deepEqual(filtered.items.map((row) => row.id), [main.id]);
    assert.equal(filtered.items[0].fromPriceMinor, 9000000);
    assert.equal((await catalog.getCourt(fixture.courts[0].id)).prices[0].currency, 'COP');
    assert.equal((await catalog.listCourts({ filters: filters({
      city: 'bogotá', sport: 'FUTBOL_5', minPriceMinor: 9500001,
    }), limit: 25 })).items.length, 0);
    assert.equal(await catalog.isCourtVisible(fixture.courts[2].id), false);

    const unpublished = await catalog.unpublish({ actor: fixture.admin, facilityId: main.id });
    assert.equal(unpublished.changed, true);
    const repeated = await catalog.unpublish({ actor: fixture.admin, facilityId: main.id });
    assert.equal(repeated.changed, false);
    const [stored] = await pool.execute(
      'SELECT publication_status, published_at, unpublished_at, deactivated_at FROM facilities WHERE id = ?',
      [main.id],
    );
    assert.equal(stored[0].publication_status, 'DRAFT');
    assert.notEqual(stored[0].published_at, null);
    assert.notEqual(stored[0].unpublished_at, null);
    assert.equal(stored[0].deactivated_at, null);
  });
});

async function seed(pool) {
  const users = [];
  for (const [name, roles] of [
    ['Catalog Admin', ['USUARIO', 'ADMINISTRADOR']],
    ['Catalog Owner', ['USUARIO', 'PROPIETARIO']],
  ]) {
    const [result] = await pool.execute('INSERT INTO users (name, email) VALUES (?, ?)',
      [name, `${randomUUID()}@catalog-integration.test`]);
    const user = { id: String(result.insertId), name, roles };
    users.push(user);
    for (const role of roles) {
      await pool.execute('INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)', [user.id, role]);
    }
  }
  const facilities = [];
  for (const [index, city] of ['Bogotá', 'Medellín', 'Bogotá'].entries()) {
    const [result] = await pool.execute(
      `INSERT INTO facilities
       (name, timezone, minimum_advance_minutes, maximum_advance_minutes,
        city, city_normalized, address, description)
       VALUES (?, 'America/Bogota', 15, 43200, ?, ?, 'Calle 1', 'Canchas cubiertas')`,
      [`Catalog ${index} ${randomUUID()}`, city, city.toLowerCase()],
    );
    facilities.push({ id: String(result.insertId) });
  }
  await pool.execute(
    `INSERT INTO facility_memberships
     (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
     VALUES (?, ?, 'PROPIETARIO', 1, UTC_TIMESTAMP(6), ?)`,
    [facilities[0].id, users[1].id, users[0].id],
  );
  const courts = [];
  for (const [index, facility] of facilities.entries()) {
    const [result] = await pool.execute(
      `INSERT INTO courts
       (facility_id, name, description, sport_code, minimum_separation_minutes, start_interval_minutes)
       VALUES (?, ?, 'Cubierta', ?, 0, 30)`,
      [facility.id, `Cancha ${index} ${randomUUID()}`, index === 1 ? 'BASKET' : 'FUTBOL_5'],
    );
    const court = { id: String(result.insertId), name: `Cancha ${index}` };
    courts.push(court);
    await pool.execute('INSERT INTO court_allowed_durations (court_id, duration_minutes) VALUES (?, 60)',
      [court.id]);
  }
  courts[0].name = (await pool.execute('SELECT name FROM courts WHERE id = ?', [courts[0].id]))[0][0].name;
  await pool.execute('UPDATE courts SET deactivated_at = UTC_TIMESTAMP(6) WHERE id = ?', [courts[2].id]);
  await pool.execute('UPDATE facilities SET deactivated_at = UTC_TIMESTAMP(6) WHERE id = ?', [facilities[2].id]);
  return { admin: users[0], owner: users[1], facilities, courts };
}
