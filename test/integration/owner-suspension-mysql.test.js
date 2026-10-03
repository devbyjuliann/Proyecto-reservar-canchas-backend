import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMySqlPool } from '../../src/database/pool.js';
import { createAuthModule, createMySqlAuthAdapter } from '../../src/modules/auth/index.js';
import { createBookingModule, createMySqlBookingAdapter } from '../../src/modules/booking/index.js';
import { createCourtPricingModule, createMySqlCourtPricingAdapter } from '../../src/modules/court-pricing/index.js';
import { createFacilitiesModule, createMySqlFacilitiesAdapter } from '../../src/modules/facilities/index.js';
import { createFacilityMembershipsModule, createMySqlFacilityMembershipsAdapter } from '../../src/modules/facility-memberships/index.js';
import { createOwnerDirectoryModule, createMySqlOwnerDirectoryAdapter } from '../../src/modules/owner-directory/index.js';
import { createPublicCatalogModule, createMySqlPublicCatalogAdapter } from '../../src/modules/public-catalog/index.js';
import { createMySqlUsersAdapter } from '../../src/modules/users/index.js';
import { createSystemClock } from '../../src/shared/clock.js';

const available = process.env.NODE_ENV === 'test' && process.env.DB_NAME?.endsWith('_test');
const ORIGIN = 'https://owner-suspension.example.test';

describe('global owner moderation with MySQL and real cookies', { skip: !available, timeout: 60_000 }, () => {
  let pool; let app; let auth; let memberships; let facilities; let pricing; let booking; let catalog;
  const ids = { users: [], facilities: [], courts: [], bookings: [] };
  const cookies = {};
  const actors = {};
  const credentials = {};

  before(async () => {
    const migration = await createMigrationConnection(loadDatabaseConfig({ forMigrations: true }));
    try { await createMigrator(migration).up(); } finally { await migration.end(); }
    pool = createMySqlPool(loadDatabaseConfig());
    const clock = createSystemClock();
    auth = createAuthModule({ adapter: createMySqlAuthAdapter({ pool }), clock });
    for (const [name, roles] of [['admin', ['ADMINISTRADOR']], ['owner', ['PROPIETARIO']],
      ['secondOwner', ['PROPIETARIO']], ['customer', []]]) {
      const email = `${name}-${randomUUID()}@owner-suspension.test`;
      credentials[name] = { email, password: `Password-${randomUUID()}!` };
      const user = await auth.register({ name: `Fixture ${name}`, ...credentials[name] });
      actors[name] = { ...user, roles: [...user.roles, ...roles] };
      ids.users.push(user.id);
      for (const role of roles) {
        await pool.execute('INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)', [user.id, role]);
      }
      const session = await auth.login(credentials[name]);
      cookies[name] = `__Host-reserva_session=${session.token}`;
    }
    facilities = createFacilitiesModule({ adapter: createMySqlFacilitiesAdapter({ pool }), clock });
    memberships = createFacilityMembershipsModule({ adapter: createMySqlFacilityMembershipsAdapter({ pool }), clock });
    const catalogAdapter = createMySqlPublicCatalogAdapter({ pool });
    catalog = createPublicCatalogModule({ adapter: catalogAdapter, clock });
    booking = createBookingModule({ adapter: createMySqlBookingAdapter({ pool, isPublicCourt: catalogAdapter.isPublicCourt }), clock });
    pricing = createCourtPricingModule({ adapter: createMySqlCourtPricingAdapter({ pool }), memberships });
    const ownerDirectory = createOwnerDirectoryModule({ adapter: createMySqlOwnerDirectoryAdapter({ pool }), clock });
    app = createApp({ environment: 'production', frontendOrigin: ORIGIN, auth, booking, facilities,
      memberships, pricing, catalog, ownerDirectory, logger: { error() {} },
      findActiveUserById: (id) => createMySqlUsersAdapter({ pool }).findById(id) });

    const { facility, membership } = await facilities.createFacility({ actor: { ...actors.owner, ownerScope: true },
      name: `Suspensión ${randomUUID().slice(0, 8)}`, timeZone: 'America/Bogota',
      city: 'Ibagué', address: 'Calle 1', description: 'Cancha cubierta' });
    ids.facility = facility.id;
    ids.membership = membership.id;
    ids.facilities.push(facility.id);
    const { court } = await booking.createCourt({ actor: { ...actors.owner, ownerScope: true },
      facilityId: facility.id, name: 'Cancha de suspensión', description: 'Fútbol cubierto',
      sportCode: 'FUTBOL_5', startIntervalMinutes: 30, minimumSeparationMinutes: 0,
      allowedDurationsMinutes: [60] });
    ids.courts.push(court.id);
    ids.court = court.id;
    await pricing.setPrice({ actor: actors.owner, scope: 'owner', courtId: court.id,
      durationMinutes: 60, priceMinor: 5000000 });
    assert.equal((await catalog.publish({ actor: actors.admin, facilityId: facility.id })).changed, true);

    const other = await facilities.createFacility({ actor: { ...actors.owner, ownerScope: true },
      name: `Membership revocada ${randomUUID().slice(0, 8)}`, timeZone: 'America/Bogota' });
    ids.facilities.push(other.facility.id);
    ids.revokedFacility = other.facility.id;
    await memberships.revokeMembership({ actor: actors.admin,
      facilityId: other.facility.id, membershipId: other.membership.id });

    const [insert] = await pool.execute(
      `INSERT INTO bookings (user_id, court_id, start_at, end_at, booking_timezone, status,
       created_at, price_amount_minor, price_currency)
       VALUES (?, ?, '2026-10-05 21:00:00', '2026-10-05 22:00:00', 'America/Bogota',
       'CONFIRMADA', '2026-09-29 12:00:00', 5000000, 'COP')`, [actors.customer.id, court.id],
    );
    ids.bookings.push(String(insert.insertId));
    const [ownBooking] = await pool.execute(
      `INSERT INTO bookings (user_id, court_id, start_at, end_at, booking_timezone, status,
       created_at, price_amount_minor, price_currency)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 7 DAY),
       DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 7 DAY) + INTERVAL 60 MINUTE,
       'America/Bogota', 'CONFIRMADA', UTC_TIMESTAMP(6), 5000000, 'COP')`,
      [actors.owner.id, court.id],
    );
    ids.bookings.push(String(ownBooking.insertId));
  });

  after(async () => {
    if (!pool) return;
    try {
      for (const id of ids.bookings) {
        await pool.execute('DELETE FROM booking_changes WHERE booking_id = ?', [id]);
        await pool.execute('DELETE FROM bookings WHERE id = ?', [id]);
      }
      for (const id of ids.courts) {
        await pool.execute('DELETE FROM operational_conflicts WHERE operational_change_id IN (SELECT id FROM operational_changes WHERE court_id = ?)', [id]);
        await pool.execute('DELETE FROM operational_changes WHERE court_id = ?', [id]);
        await pool.execute('DELETE FROM court_prices WHERE court_id = ?', [id]);
        await pool.execute('DELETE FROM court_allowed_durations WHERE court_id = ?', [id]);
        await pool.execute('DELETE FROM courts WHERE id = ?', [id]);
      }
      for (const id of ids.facilities) {
        await pool.execute('DELETE FROM facility_memberships WHERE facility_id = ?', [id]);
        await pool.execute('DELETE FROM facilities WHERE id = ?', [id]);
      }
      for (const id of ids.users) {
        await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
        await pool.execute('DELETE FROM user_credentials WHERE user_id = ?', [id]);
        await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [id]);
        await pool.execute('DELETE FROM users WHERE id = ?', [id]);
      }
    } finally { await pool.end(); }
  });

  it('limits listing and detail to Admin; searches name/email and binds the cursor to filters', async () => {
    await request(app).get('/api/v1/admin/owners').expect(401);
    await request(app).get('/api/v1/admin/owners').set('Cookie', cookies.customer).expect(403);
    await request(app).get('/api/v1/admin/owners').set('Cookie', cookies.owner).expect(403);
    const path = '/api/v1/admin/owners';
    const owners = await request(app).get(`${path}?limit=1`).set('Cookie', cookies.admin).expect(200);
    assert.equal(owners.body.items.length, 1);
    assert.ok(owners.body.page.nextCursor);
    await request(app).get(`${path}?limit=1&cursor=${owners.body.page.nextCursor}`).set('Cookie', cookies.admin).expect(200);
    await request(app).get(`${path}?q=other&cursor=${owners.body.page.nextCursor}`).set('Cookie', cookies.admin).expect(400);
    await request(app).get(`${path}?unknown=1`).set('Cookie', cookies.admin).expect(400);
    for (const q of ['Fixture%20owner', credentials.owner.email.slice(0, 18)]) {
      const result = await request(app).get(`${path}?q=${q}`).set('Cookie', cookies.admin).expect(200);
      assert.equal(result.body.items.some((row) => row.id === actors.owner.id), true);
    }
    const detail = await request(app).get(`${path}/${actors.owner.id}`).set('Cookie', cookies.admin).expect(200);
    assert.equal(detail.body.owner.memberships.length, 2);
    assert.equal(detail.body.owner.memberships.some((row) => row.active === false), true);
    assert.equal(detail.body.owner.memberships.some((row) => row.facility.publicationState === 'PUBLISHED'), true);
    assert.equal(JSON.stringify(detail.body).includes('password_hash'), false);
    await request(app).get(`${path}/999999999999`).set('Cookie', cookies.admin).expect(404);
    await request(app).get(`${path}/${actors.customer.id}`).set('Cookie', cookies.admin).expect(404);
  });

  it('suspends only Owner abilities, preserves published business and bookings, then restores active memberships', async () => {
    const path = `/api/v1/admin/owners/${actors.owner.id}/suspension`;
    await request(app).post(path).set('Origin', ORIGIN).set('Cookie', cookies.customer).expect(403);
    await request(app).post(path).set('Origin', ORIGIN).set('Cookie', cookies.secondOwner).expect(403);
    await request(app).post(path).set('Origin', ORIGIN).set('Cookie', cookies.admin).send({}).expect(400);
    const suspended = await request(app).post(path).set('Origin', ORIGIN).set('Cookie', cookies.admin).expect(200);
    assert.equal(suspended.body.operation.changed, true);
    assert.equal(suspended.body.owner.state, 'suspended');
    const timestamp = suspended.body.owner.ownerSuspendedAt;
    const repeat = await request(app).post(path).set('Origin', ORIGIN).set('Cookie', cookies.admin).expect(200);
    assert.equal(repeat.body.operation.changed, false);
    assert.equal(repeat.body.owner.ownerSuspendedAt, timestamp);

    // The same cookie and credentials still work for ordinary USUARIO actions.
    await request(app).get('/api/v1/me').set('Cookie', cookies.owner).expect(200)
      .expect(({ body }) => assert.ok(body.user.roles.includes('PROPIETARIO')));
    await request(app).get('/api/v1/me/bookings').set('Cookie', cookies.owner).expect(200)
      .expect(({ body }) => assert.equal(body.items.some((row) => row.id === ids.bookings[1]), true));
    assert.equal((await auth.login(credentials.owner)).user.id, actors.owner.id);
    await request(app).post(`/api/v1/bookings/${ids.bookings[1]}/cancellation`)
      .set('Origin', ORIGIN).set('Cookie', cookies.owner).expect(200)
      .expect(({ body }) => assert.equal(body.booking.status, 'CANCELADA'));
    for (const endpoint of ['/api/v1/owner/facilities', '/api/v1/owner/bookings',
      `/api/v1/owner/facilities/${ids.facility}`, `/api/v1/owner/courts/${ids.court}`,
      `/api/v1/owner/courts/${ids.court}/prices`]) {
      await request(app).get(endpoint).set('Cookie', cookies.owner).expect(403)
        .expect(({ body }) => assert.equal(body.error.code, 'owner_suspended'));
    }
    await request(app).post('/api/v1/owner/facilities').set('Origin', ORIGIN).set('Cookie', cookies.owner)
      .send({ name: 'No autorizado', timeZone: 'America/Bogota' }).expect(403);
    await request(app).put(`/api/v1/owner/courts/${ids.court}/prices/60`).set('Origin', ORIGIN).set('Cookie', cookies.owner)
      .send({ priceMinor: 9000000, currency: 'COP' }).expect(403);
    await assert.rejects(memberships.requireMembership({ actor: actors.owner, facilityId: ids.facility }),
      { code: 'resource_not_found' });
    const [bookingRows] = await pool.execute('SELECT status, price_amount_minor FROM bookings WHERE id = ?', [ids.bookings[0]]);
    assert.equal(bookingRows[0].status, 'CONFIRMADA');
    assert.equal(Number(bookingRows[0].price_amount_minor), 5000000);
    const [memberRows] = await pool.execute('SELECT active FROM facility_memberships WHERE id = ?', [ids.membership]);
    assert.equal(Number(memberRows[0].active), 1);
    await request(app).get(`/api/v1/facilities/${ids.facility}`).expect(200);

    const restored = await request(app).delete(path).set('Origin', ORIGIN).set('Cookie', cookies.admin).expect(200);
    assert.equal(restored.body.operation.changed, true);
    assert.equal(restored.body.owner.state, 'active');
    await request(app).delete(path).set('Origin', ORIGIN).set('Cookie', cookies.admin).expect(200)
      .expect(({ body }) => assert.equal(body.operation.changed, false));
    await request(app).get(`/api/v1/owner/facilities/${ids.facility}`).set('Cookie', cookies.owner).expect(200);
    await request(app).get(`/api/v1/owner/facilities/${ids.revokedFacility}`).set('Cookie', cookies.owner).expect(404);
    await request(app).get(`/api/v1/facilities/${ids.facility}`).expect(200);
    const [unchanged] = await pool.execute('SELECT status FROM bookings WHERE id = ?', [ids.bookings[0]]);
    assert.equal(unchanged[0].status, 'CONFIRMADA');
  });
});
