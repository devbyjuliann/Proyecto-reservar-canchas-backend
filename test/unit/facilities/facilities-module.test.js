import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApplicationError } from '../../../src/shared/errors.js';
import { createFacilitiesModule } from '../../../src/modules/facilities/index.js';

const ACTOR = { id: '7', roles: ['ADMINISTRADOR'] };
const CREATED_AT = '2026-09-24T14:00:00.000000Z';

function facility(overrides = {}) {
  return {
    id: '3',
    name: 'Centro Deportivo',
    timeZone: 'America/Bogota',
    minimumAdvanceMinutes: 15,
    maximumAdvanceMinutes: 43_200,
    createdAt: CREATED_AT,
    deactivatedAt: null,
    ...overrides,
  };
}

function court(overrides = {}) {
  return {
    id: '12',
    facility: { id: '3', name: 'Centro Deportivo' },
    name: 'Cancha 1',
    description: 'Cubierta',
    minimumSeparationMinutes: 10,
    startIntervalMinutes: 30,
    allowedDurationsMinutes: [90, 30, 60],
    createdAt: CREATED_AT,
    deactivatedAt: null,
    ...overrides,
  };
}

describe('facilities catalog module', () => {
  it('exposes only descriptive catalog operations', () => {
    const module = createFacilitiesModule({ adapter: {} });
    assert.deepEqual(Object.keys(module), [
      'listFacilities',
      'createFacility',
      'getFacility',
      'updateFacility',
      'listCourts',
      'getCourt',
       'updateCourt',
       'reactivateFacility',
    ]);
  });

  it('requires ADMINISTRADOR for reads as well as writes', async () => {
    const module = createFacilitiesModule({ adapter: { getFacility() {} } });
    await assert.rejects(
      module.getFacility({ actor: { id: '7', roles: ['USUARIO'] }, facilityId: '3' }),
      (error) => error instanceof ApplicationError && error.code === 'forbidden',
    );
  });

  it('rejects unknown collection parameters', async () => {
    const module = createFacilitiesModule({ adapter: { async listFacilities() { return []; } } });
    await assert.rejects(
      module.listFacilities({ actor: ACTOR, sort: 'name' }),
      { code: 'invalid_request' },
    );
  });

  it('creates a facility with an explicit normalized instant and operation envelope', async () => {
    let request;
    const module = createFacilitiesModule({
      adapter: {
        async createFacility(value) {
          request = value;
          return { facility: facility() };
        },
      },
    });
    const result = await module.createFacility({
      actor: ACTOR,
      input: { name: ' Centro Deportivo ', timeZone: 'America/Bogota' },
      now: '2026-09-24T14:00:00Z',
    });

    assert.equal(request.now, CREATED_AT);
    assert.equal(request.input.name, 'Centro Deportivo');
    assert.deepEqual(result.operation, { changed: true, changes: [] });
    assert.equal(result.facility.id, '3');
    assert.equal(result.facility.state, 'active');
  });

  it('reads inactive facilities and formats their timestamps', async () => {
    const module = createFacilitiesModule({
      adapter: {
        async getFacility() {
          return facility({ deactivatedAt: '2026-09-25 15:30:00.123456' });
        },
      },
    });
    const result = await module.getFacility({ actor: ACTOR, facilityId: '3' });
    assert.equal(result.state, 'inactive');
    assert.equal(result.deactivatedAt, '2026-09-25T15:30:00.123456Z');
  });

  it('returns a no-op envelope without hiding the resulting facility', async () => {
    const module = createFacilitiesModule({
      adapter: {
        async updateFacility() {
          return { status: 'ok', changed: false, facility: facility() };
        },
      },
    });
    const result = await module.updateFacility({
      actor: ACTOR,
      facilityId: '3',
      input: { name: 'Centro Deportivo' },
    });
    assert.deepEqual(result.operation, { changed: false, changes: [] });
  });

  it('maps inactive mutation outcomes to resource_inactive', async () => {
    const module = createFacilitiesModule({
      adapter: { async updateCourt() { return { status: 'inactive' }; } },
    });
    await assert.rejects(
      module.updateCourt({
        actor: ACTOR,
        courtId: '12',
        input: { description: null },
      }),
      { code: 'resource_inactive' },
    );
  });

  it('paginates by opaque cursors bound to the state filter', async () => {
    const requests = [];
    const module = createFacilitiesModule({
      adapter: {
        async listFacilities(request) {
          requests.push(request);
          return request.cursor
            ? []
            : [facility(), facility({ id: '4', name: 'Sur' })];
        },
      },
    });
    const first = await module.listFacilities({ actor: ACTOR, state: 'all', limit: 1 });
    assert.equal(first.items.length, 1);
    assert.equal(typeof first.page.nextCursor, 'string');
    assert.deepEqual(requests[0], { state: 'all', limit: 2, cursor: undefined });

    await module.listFacilities({
      actor: ACTOR,
      state: 'all',
      limit: 1,
      cursor: first.page.nextCursor,
    });
    assert.deepEqual(requests[1].cursor, { name: 'Centro Deportivo', id: '3' });
    await assert.rejects(
      module.listFacilities({
        actor: ACTOR,
        state: 'active',
        limit: 1,
        cursor: first.page.nextCursor,
      }),
      { code: 'invalid_request' },
    );
  });

  it('lists courts for inactive facilities and includes sorted durations', async () => {
    let request;
    const module = createFacilitiesModule({
      adapter: {
        async listCourts(value) {
          request = value;
          return [court()];
        },
      },
    });
    const result = await module.listCourts({ actor: ACTOR, facilityId: '3' });
    assert.equal(request.state, 'active');
    assert.equal(request.limit, 26);
    assert.deepEqual(result.items[0].allowedDurationsMinutes, [30, 60, 90]);
    assert.deepEqual(result.items[0].facility, { id: '3', name: 'Centro Deportivo' });
  });

  it('reports missing facilities when listing courts', async () => {
    const module = createFacilitiesModule({
      adapter: { async listCourts() { return null; } },
    });
    await assert.rejects(
      module.listCourts({ actor: ACTOR, facilityId: '999' }),
      { code: 'resource_not_found' },
    );
  });
});
