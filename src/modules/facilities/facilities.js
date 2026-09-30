import { toInstantString } from '../../shared/time.js';
import { facilitiesError } from './errors.js';
import {
  assertAdministrator,
  validateCreateFacilityInput,
  validateId,
  validateLimit,
  validateNow,
  validateState,
  validateUpdateCourtInput,
  validateUpdateFacilityInput,
} from './validation.js';

const OPERATION_UNCHANGED = Object.freeze({ changed: false, changes: Object.freeze([]) });

export function createFacilitiesModule({ adapter, clock }) {
  if (!adapter) throw new TypeError('A facilities adapter is required');

  return Object.freeze({
    listFacilities,
    createFacility,
    getFacility,
    updateFacility,
    listCourts,
    getCourt,
    updateCourt,
    reactivateFacility,
  });

  async function listFacilities({ actor, state, limit, cursor, ...unknown } = {}) {
    assertAdministrator(actor);
    rejectUnknownArguments(unknown);
    const filter = validateState(state);
    const pageSize = validateLimit(limit);
    const decodedCursor = decodeCursor(cursor, { resource: 'facilities', state: filter });
    const rows = await adapter.listFacilities({
      state: filter,
      limit: pageSize + 1,
      cursor: decodedCursor,
    });
    return presentPage(rows, pageSize, (row) => presentFacility(row), {
      resource: 'facilities',
      state: filter,
    });
  }

  async function createFacility({ actor, input, now, ...flatInput } = {}) {
    assertFacilityActor(actor);
    const result = await adapter.createFacility({
      input: validateCreateFacilityInput(input ?? flatInput),
      now: validateNow(now ?? clock?.now?.()),
      ...(actor.ownerScope ? { ownerUserId: String(actor.id) } : {}),
    });
    return {
      facility: presentFacility(result.facility ?? result),
      ...(result.membership ? { membership: result.membership } : {}),
      operation: { changed: true, changes: [] },
    };
  }

  async function getFacility({ actor, facilityId, ...unknown } = {}) {
    assertAdministrator(actor);
    rejectUnknownArguments(unknown);
    const facility = await adapter.getFacility(validateId(facilityId, 'facilityId'));
    if (!facility) throw facilitiesError('resource_not_found');
    return presentFacility(facility);
  }

  async function updateFacility({ actor, facilityId, input, ...flatInput } = {}) {
    assertFacilityActor(actor);
    const result = await adapter.updateFacility({
      facilityId: validateId(facilityId, 'facilityId'),
      input: validateUpdateFacilityInput(input ?? flatInput),
      ...(actor.ownerScope ? { ownerUserId: String(actor.id) } : {}),
    });
    assertMutationResult(result);
    return {
      facility: presentFacility(result.facility),
      operation: operation(result.changed),
    };
  }

  async function reactivateFacility({ actor, facilityId } = {}) {
    assertAdministrator(actor);
    const result = await adapter.reactivateFacility(validateId(facilityId, 'facilityId'));
    if (!result) throw facilitiesError('resource_not_found');
    return { facility: presentFacility(result.facility), operation: operation(result.changed) };
  }

  async function listCourts({ actor, facilityId, state, limit, cursor, ...unknown } = {}) {
    assertFacilityActor(actor);
    rejectUnknownArguments(unknown);
    const id = validateId(facilityId, 'facilityId');
    const filter = validateState(state);
    const pageSize = validateLimit(limit);
    const binding = { resource: 'courts', facilityId: id, state: filter };
    const rows = await adapter.listCourts({
      facilityId: id,
      state: filter,
      limit: pageSize + 1,
      cursor: decodeCursor(cursor, binding),
    });
    if (rows === null) throw facilitiesError('resource_not_found');
    return presentPage(rows, pageSize, (row) => presentCourt(row), binding);
  }

  async function getCourt({ actor, courtId, ...unknown } = {}) {
    assertFacilityActor(actor);
    rejectUnknownArguments(unknown);
    const court = await adapter.getCourt(validateId(courtId, 'courtId'));
    if (!court) throw facilitiesError('resource_not_found');
    return presentCourt(court);
  }

  async function updateCourt({ actor, courtId, input, ...flatInput } = {}) {
    assertFacilityActor(actor);
    const result = await adapter.updateCourt({
      courtId: validateId(courtId, 'courtId'),
      input: validateUpdateCourtInput(input ?? flatInput),
      ...(actor.ownerScope ? { ownerUserId: String(actor.id) } : {}),
    });
    assertMutationResult(result);
    return {
      court: presentCourt(result.court),
      operation: operation(result.changed),
    };
  }
}

function assertFacilityActor(actor) {
  if (actor?.ownerScope === true) {
    if (actor.id == null || !actor.roles?.includes('PROPIETARIO')) {
      throw facilitiesError('forbidden');
    }
    return;
  }
  assertAdministrator(actor);
}

function assertMutationResult(result) {
  if (!result || result.status === 'not_found') throw facilitiesError('resource_not_found');
  if (result.status === 'inactive') throw facilitiesError('resource_inactive');
}

function rejectUnknownArguments(unknown) {
  const field = Object.keys(unknown)[0];
  if (field) {
    throw facilitiesError('invalid_request', {
      details: [{ field, message: `Unknown field: ${field}` }],
    });
  }
}

function operation(changed) {
  return changed ? { changed: true, changes: [] } : OPERATION_UNCHANGED;
}

function presentPage(rows, limit, presenter, binding) {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(presenter),
    page: {
      nextCursor: hasMore && last
        ? encodeCursor({ ...binding, name: last.name, id: String(last.id) })
        : null,
    },
  };
}

function presentFacility(facility) {
  return {
    id: String(facility.id),
    name: facility.name,
    timeZone: facility.timeZone,
    minimumAdvanceMinutes: Number(facility.minimumAdvanceMinutes),
    maximumAdvanceMinutes: Number(facility.maximumAdvanceMinutes),
    createdAt: toInstantString(facility.createdAt),
    deactivatedAt: facility.deactivatedAt == null
      ? null
      : toInstantString(facility.deactivatedAt),
    state: facility.deactivatedAt == null ? 'active' : 'inactive',
    ...(Object.hasOwn(facility, 'city') ? {
      city: facility.city, address: facility.address, description: facility.description,
      publicationState: facility.publicationState,
      publishedAt: facility.publishedAt == null ? null : toInstantString(facility.publishedAt),
      publishedByUserId: facility.publishedByUserId,
      unpublishedAt: facility.unpublishedAt == null ? null : toInstantString(facility.unpublishedAt),
    } : {}),
  };
}

function presentCourt(court) {
  return {
    id: String(court.id),
    facility: { id: String(court.facility.id), name: court.facility.name },
    name: court.name,
    description: court.description,
    ...(Object.hasOwn(court, 'sportCode') ? { sportCode: court.sportCode } : {}),
    minimumSeparationMinutes: Number(court.minimumSeparationMinutes),
    startIntervalMinutes: Number(court.startIntervalMinutes),
    allowedDurationsMinutes: court.allowedDurationsMinutes.map(Number).sort((a, b) => a - b),
    createdAt: toInstantString(court.createdAt),
    deactivatedAt: court.deactivatedAt == null ? null : toInstantString(court.deactivatedAt),
    state: court.deactivatedAt == null ? 'active' : 'inactive',
  };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ v: 1, ...value })).toString('base64url');
}

function decodeCursor(cursor, binding) {
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    const expectedKeys = binding.facilityId === undefined
      ? ['id', 'name', 'resource', 'state', 'v']
      : ['facilityId', 'id', 'name', 'resource', 'state', 'v'];
    if (
      !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',')
      || value.v !== 1
      || value.resource !== binding.resource
      || value.state !== binding.state
      || value.facilityId !== binding.facilityId
      || typeof value.name !== 'string'
      || value.name.length === 0
      || value.name.length > 150
    ) throw new Error();
    return { name: value.name, id: validateId(value.id, 'cursor') };
  } catch (cause) {
    throw facilitiesError('invalid_request', {
      details: [{ field: 'cursor', message: 'Must be a valid cursor for this collection' }],
      cause,
    });
  }
}
