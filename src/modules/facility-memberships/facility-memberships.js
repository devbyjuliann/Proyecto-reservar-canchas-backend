import { toInstantString } from '../../shared/time.js';
import { appError } from '../../shared/errors.js';

const MAX_ID = 18_446_744_073_709_551_615n;

export function createFacilityMembershipsModule({ adapter, clock }) {
  if (!adapter || typeof clock?.now !== 'function') {
    throw new TypeError('A membership adapter and clock are required');
  }

  return Object.freeze({
    listMemberships, getMembership, assignMembership, revokeMembership,
    listOwnedFacilities, getOwnedFacility, requireMembership,
    requireCourtMembership, requireUnavailabilityMembership,
  });

  async function listMemberships({ actor, facilityId, limit, cursor }) {
    requireAdministrator(actor);
    if (!await adapter.facilityExists(facilityId)) throw error('resource_not_found');
    const rows = await adapter.listMemberships({
      facilityId, limit: limit + 1,
      position: cursor ? decodeCursor(cursor, 'memberships', facilityId) : null,
    });
    return page(rows, limit, 'memberships', facilityId, (last) => ({ createdAt: last.grantedAt, id: last.id }));
  }

  async function getMembership({ actor, facilityId, membershipId }) {
    requireAdministrator(actor);
    const membership = await adapter.getMembership({ facilityId, membershipId });
    if (!membership) throw error('resource_not_found');
    return membership;
  }

  async function assignMembership({ actor, facilityId, userId }) {
    requireAdministrator(actor);
    const result = await adapter.assign({
      facilityId, userId, createdByUserId: String(actor.id), now: toInstantString(clock.now()),
    });
    if (typeof result === 'string') throw error(result);
    return result;
  }

  async function revokeMembership({ actor, facilityId, membershipId }) {
    requireAdministrator(actor);
    const result = await adapter.revoke({
      facilityId, membershipId, now: toInstantString(clock.now()),
    });
    if (!result) throw error('resource_not_found');
    return result;
  }

  async function listOwnedFacilities({ actor, limit, cursor }) {
    requireOwnerRole(actor);
    const rows = await adapter.listOwnedFacilities({
      userId: String(actor.id), limit: limit + 1,
      position: cursor ? decodeCursor(cursor, 'owned-facilities', String(actor.id)) : null,
    });
    return page(rows, limit, 'owned-facilities', String(actor.id), (last) => ({ name: last.name, id: last.id }));
  }

  async function requireMembership({ actor, facilityId }) {
    requireOwnerRole(actor);
    const facility = await adapter.getOwnedFacility({ userId: String(actor.id), facilityId });
    if (!facility) throw error('resource_not_found');
    return facility;
  }

  async function getOwnedFacility({ actor, facilityId }) {
    return requireMembership({ actor, facilityId });
  }

  async function requireCourtMembership({ actor, courtId }) {
    requireOwnerRole(actor);
    const facilityId = await adapter.resolveCourtFacilityId(courtId);
    if (!facilityId) throw error('resource_not_found');
    return requireMembership({ actor, facilityId });
  }

  async function requireUnavailabilityMembership({ actor, unavailabilityId }) {
    requireOwnerRole(actor);
    const courtId = await adapter.resolveUnavailabilityCourtId(unavailabilityId);
    if (!courtId) throw error('resource_not_found');
    return requireCourtMembership({ actor, courtId });
  }
}

function page(rows, limit, kind, scope, position) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    page: {
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: 1, kind, scope, position: position(last) })).toString('base64url')
        : null,
    },
  };
}

function decodeCursor(value, kind, scope) {
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1024) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const decoded = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(decoded).sort().join(',') !== 'kind,position,scope,v'
      || decoded.v !== 1 || decoded.kind !== kind || decoded.scope !== scope
      || decoded.position == null || typeof decoded.position !== 'object') throw new Error();
    const position = decoded.position;
    if (typeof position.id !== 'string' || !/^[1-9]\d*$/.test(position.id)
      || BigInt(position.id) > MAX_ID) throw new Error();
    if (kind === 'memberships') {
      if (Object.keys(position).sort().join(',') !== 'createdAt,id'
        || toInstantString(position.createdAt) !== position.createdAt) throw new Error();
    } else if (Object.keys(position).sort().join(',') !== 'id,name'
      || typeof position.name !== 'string' || position.name.length > 150) throw new Error();
    return position;
  } catch {
    throw appError('invalid_request', 'The request is invalid', {
      details: [{ field: 'cursor', message: 'Must match this collection and scope' }],
    });
  }
}

function requireAdministrator(actor) {
  if (!actor?.roles?.includes('ADMINISTRADOR')) throw error('forbidden');
}

function requireOwnerRole(actor) {
  if (!actor?.roles?.includes('PROPIETARIO')) throw error('forbidden');
}

function error(code) {
  return appError(code, ({
    forbidden: 'The user cannot perform this operation',
    resource_not_found: 'The requested resource was not found',
    membership_conflict: 'The membership cannot be created',
    resource_inactive: 'The user is inactive',
  })[code]);
}
