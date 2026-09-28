import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { createFacilityMembershipsModule } from '../../src/modules/facility-memberships/index.js';

const ORIGIN = 'https://app.example.test';
const URL = '/api/v1/admin/facilities/11/memberships';
const OWN = '/api/v1/owner/facilities';
const facility = { id: '11', name: 'Sede Norte', timeZone: 'America/Bogota', state: 'active' };
const user = { id: '1', roles: ['USUARIO'] };
const admin = { id: '2', roles: ['USUARIO', 'ADMINISTRADOR'] };
const owner = { id: '3', roles: ['USUARIO', 'PROPIETARIO'] };

function fixture() {
  let membership = null;
  const adapter = {
    async facilityExists(id) { return id === '11'; },
    async listMemberships() { return membership ? [membership] : []; },
    async getMembership() { return membership; },
    async assign({ userId, createdByUserId }) {
      if (userId === user.id || userId === '4') return 'membership_conflict';
      membership = {
        id: '51', facilityId: '11', userId, membershipRole: 'PROPIETARIO',
        active: true, grantedAt: '2026-09-25T12:00:00.000000Z', revokedAt: null,
        createdByUserId,
      };
      return membership;
    },
    async revoke() {
      const changed = membership.active;
      membership = { ...membership, active: false, revokedAt: '2026-09-25T12:00:00.000000Z' };
      return { membership, changed };
    },
    async listOwnedFacilities({ userId }) {
      return membership?.active && membership.userId === userId ? [facility] : [];
    },
    async getOwnedFacility({ userId, facilityId }) {
      return membership?.active && membership.userId === userId && facilityId === '11' ? facility : null;
    },
  };
  const app = createApp({
    environment: 'production', frontendOrigin: ORIGIN,
    auth: {
      async resolveSession(token) {
        const actor = ({ user, admin, owner })[token];
        return actor ? { sessionId: token, user: actor } : null;
      },
      async register() {}, async login() {}, async revokeSession() {},
    },
    memberships: createFacilityMembershipsModule({
      adapter, clock: { now: () => '2026-09-25T12:00:00.000000Z' },
    }),
    booking: { async getAvailability() { return { options: [] }; } },
    findActiveUserById: async () => null,
    logger: { error() {} },
  });
  return app;
}

const cookie = (role) => `__Host-reserva_session=${role}`;

describe('facility memberships HTTP contract', () => {
  it('permits assignment only to ADMINISTRADOR and checks the owner role', async () => {
    const app = fixture();
    await request(app).post(URL).set('Origin', ORIGIN).send({ userId: '3', membershipRole: 'PROPIETARIO' })
      .expect(401);
    await request(app).post(URL).set('Origin', ORIGIN).set('Cookie', cookie('owner'))
      .send({ userId: '3', membershipRole: 'PROPIETARIO' }).expect(403);
    await request(app).post(URL).set('Origin', ORIGIN).set('Cookie', cookie('admin'))
      .send({ userId: '1', membershipRole: 'PROPIETARIO' }).expect(409)
      .expect(({ body }) => assert.equal(body.error.code, 'membership_conflict'));
    await request(app).post(URL).set('Origin', ORIGIN).set('Cookie', cookie('admin'))
      .send({ userId: '3', membershipRole: 'ADMINISTRADOR' }).expect(400);
    const assigned = await request(app).post(URL).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin'))
      .send({ userId: '3', membershipRole: 'PROPIETARIO' }).expect(201);
    assert.equal(assigned.headers.location, `${URL}/51`);
    assert.equal(assigned.body.membership.userId, '3');
    await request(app).get(URL).set('Cookie', cookie('admin')).expect(200)
      .expect(({ body }) => assert.equal(body.items[0].membershipRole, 'PROPIETARIO'));
  });

  it('scopes owner reads and removes access immediately after revocation', async () => {
    const app = fixture();
    await request(app).get(OWN).set('Cookie', cookie('user')).expect(403);
    await request(app).get(OWN).set('Cookie', cookie('admin')).expect(403);
    await request(app).get(OWN).set('Cookie', cookie('owner')).expect(200)
      .expect(({ body }) => assert.deepEqual(body.items, []));
    await request(app).post(URL).set('Origin', ORIGIN).set('Cookie', cookie('admin'))
      .send({ userId: '3', membershipRole: 'PROPIETARIO' }).expect(201);
    await request(app).get(`${OWN}/11`).set('Cookie', cookie('owner')).expect(200);
    await request(app).get(`${OWN}/12`).set('Cookie', cookie('owner')).expect(404);
    await request(app).post(`${URL}/51/revocation`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).expect(200)
      .expect(({ body }) => assert.equal(body.operation.changed, true));
    await request(app).get(`${OWN}/11`).set('Cookie', cookie('owner')).expect(404);
    await request(app).get(OWN).set('Cookie', cookie('owner')).expect(200)
      .expect(({ body }) => assert.deepEqual(body.items, []));
    await request(app).post(`${URL}/51/revocation`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).expect(200)
      .expect(({ body }) => assert.equal(body.operation.changed, false));
    await request(app).get(`${URL}/51`).set('Cookie', cookie('admin')).expect(200)
      .expect(({ body }) => assert.equal(body.membership.active, false));
  });
});
