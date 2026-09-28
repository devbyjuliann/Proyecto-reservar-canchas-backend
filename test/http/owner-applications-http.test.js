import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { createOwnerApplicationsModule } from '../../src/modules/owner-applications/index.js';

const ORIGIN = 'https://app.example.test';
const OWN = '/api/v1/me/owner-applications';
const ADMIN = '/api/v1/admin/owner-applications';
const APPLICATION = {
  id: '51', userId: '1', businessName: 'Centro Deportivo', message: null,
  status: 'PENDIENTE', createdAt: '2026-09-25T12:00:00.000000Z',
  decidedAt: null, reviewerUserId: null, decisionReason: null,
};

function fixture() {
  const calls = [];
  const user = { id: '1', name: 'Solicitante', email: 'u@example.test', roles: ['USUARIO'] };
  const admin = { id: '2', name: 'Admin', email: 'a@example.test', roles: ['USUARIO', 'ADMINISTRADOR'] };
  const adapter = {
    async create(input) { calls.push(['create', input]); return APPLICATION; },
    async list(input) { calls.push(['list', input]); return [APPLICATION]; },
    async get(input) { calls.push(['get', input]); return input.userId === '2' ? null : APPLICATION; },
    async decide(input) { calls.push(['decide', input]); return {
      ownerApplication: { ...APPLICATION, status: input.decision, reviewerUserId: input.reviewerId },
      ...(input.decision === 'APROBADA' ? { user: { id: '1', roles: ['USUARIO', 'PROPIETARIO'] } } : {}),
    }; },
  };
  const app = createApp({
    environment: 'production', frontendOrigin: ORIGIN,
    auth: {
      async resolveSession(token) {
        const current = token === 'user' ? user : token === 'admin' ? admin : null;
        return current ? { sessionId: token, user: current } : null;
      },
      async register() {}, async login() {}, async revokeSession() {},
    },
    ownerApplications: createOwnerApplicationsModule({
      adapter, clock: { now: () => '2026-09-25T12:00:00.000000Z' },
    }),
    booking: { async getAvailability() { return { options: [] }; } },
    findActiveUserById: async () => null,
    logger: { error() {} },
  });
  return { app, calls };
}

const cookie = (role) => `__Host-reserva_session=${role}`;

describe('owner applications HTTP contract', () => {
  it('requires a session, validates input, creates pending and lists only own history', async () => {
    const { app, calls } = fixture();
    await request(app).post(OWN).set('Origin', ORIGIN)
      .send({ businessName: 'Centro' }).expect(401);
    await request(app).post(OWN).set('Origin', ORIGIN).set('Cookie', cookie('user'))
      .send({ businessName: 'Centro', userId: '2' }).expect(400);
    const created = await request(app).post(OWN).set('Origin', ORIGIN)
      .set('Cookie', cookie('user'))
      .send({ businessName: '  Centro Deportivo  ', message: null }).expect(201);
    assert.equal(created.headers.location, `${OWN}/51`);
    assert.equal(created.body.ownerApplication.status, 'PENDIENTE');
    assert.equal(calls.find(([name]) => name === 'create')[1].businessName, 'Centro Deportivo');
    await request(app).get(OWN).set('Cookie', cookie('user')).expect(200)
      .expect(({ body }) => assert.equal(body.items[0].userId, '1'));
    await request(app).get(`${OWN}/51`).set('Cookie', cookie('user')).expect(200);
    await request(app).get(`${OWN}/51`).set('Cookie', cookie('admin')).expect(404);
  });

  it('allows only ADMINISTRADOR to list or decide, with existing error envelope', async () => {
    const { app, calls } = fixture();
    await request(app).get(ADMIN).set('Cookie', cookie('user')).expect(403)
      .expect(({ body }) => assert.equal(body.error.code, 'forbidden'));
    await request(app).post(`${ADMIN}/51/approval`).set('Origin', ORIGIN)
      .set('Cookie', cookie('user')).expect(403);
    await request(app).get(ADMIN).set('Cookie', cookie('admin')).expect(200);
    await request(app).post(`${ADMIN}/51/approval`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).send({ status: 'APROBADA' }).expect(400);
    const approved = await request(app).post(`${ADMIN}/51/approval`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).expect(200);
    assert.deepEqual(approved.body.user.roles, ['USUARIO', 'PROPIETARIO']);
    await request(app).post(`${ADMIN}/51/rejection`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).send({ reason: '  ' }).expect(400);
    await request(app).post(`${ADMIN}/51/rejection`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).send({ reason: '  Falta información  ' }).expect(200);
    assert.equal(calls.filter(([name]) => name === 'decide').length, 2);
    assert.equal(calls.at(-1)[1].reason, 'Falta información');
  });

  it('rejects malformed filters and cursors in both collections', async () => {
    const { app } = fixture();
    await request(app).get(`${OWN}?limit=101`).set('Cookie', cookie('user')).expect(400);
    await request(app).get(`${OWN}?cursor=bad`).set('Cookie', cookie('user')).expect(400);
    await request(app).get(`${ADMIN}?status=UNKNOWN`).set('Cookie', cookie('admin')).expect(400);
    await request(app).get(`${ADMIN}?cursor=bad`).set('Cookie', cookie('admin')).expect(400);
  });
});
