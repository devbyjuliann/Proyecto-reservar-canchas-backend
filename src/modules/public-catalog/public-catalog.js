import { appError } from '../../shared/errors.js';
import { toInstantString } from '../../shared/time.js';

const MAX_ID = 18_446_744_073_709_551_615n;

export function createPublicCatalogModule({ adapter, clock }) {
  if (!adapter || typeof clock?.now !== 'function') {
    throw new TypeError('A catalog adapter and clock are required');
  }
  return Object.freeze({ listFacilities, getFacility, listFacilityCourts, listCourts,
    getCourt, isCourtVisible, publish, unpublish });

  async function listFacilities({ limit, cursor, filters }) {
    return list('facilities', null, limit, cursor, filters);
  }

  async function listFacilityCourts({ facilityId, limit, cursor, filters }) {
    if (!await adapter.pricingReady()) throw notFound();
    if (!await adapter.getFacility(facilityId)) throw notFound();
    return list('facility-courts', facilityId, limit, cursor, filters);
  }

  async function listCourts({ limit, cursor, filters }) {
    return list('courts', null, limit, cursor, filters);
  }

  async function getFacility(facilityId) {
    if (!await adapter.pricingReady()) throw notFound();
    const facility = await adapter.getFacility(facilityId);
    if (!facility) throw notFound();
    return facility;
  }

  async function getCourt(courtId) {
    if (!await adapter.pricingReady()) throw notFound();
    const court = await adapter.getCourt(courtId);
    if (!court) throw notFound();
    return court;
  }

  async function isCourtVisible(courtId) {
    return await adapter.pricingReady() && Boolean(await adapter.getCourt(courtId));
  }

  async function publish({ actor, facilityId }) {
    requireAdmin(actor);
    const result = await adapter.publish({
      facilityId, actorUserId: String(actor.id), now: toInstantString(clock.now()),
    });
    if (result === null) throw notFound();
    if (result === false) throw appError('facility_not_publishable', 'The facility is not publishable');
    return result;
  }

  async function unpublish({ actor, facilityId }) {
    requireAdmin(actor);
    const result = await adapter.unpublish({ facilityId, now: toInstantString(clock.now()) });
    if (result === null) throw notFound();
    return result;
  }

  async function list(kind, facilityId, limit, cursor, filters) {
    const position = cursor ? decodeCursor(cursor, kind, facilityId, filters) : null;
    // 012 must provide a positive COP price before any resource may become public.
    if (!await adapter.pricingReady()) return { items: [], page: { nextCursor: null } };
    const rows = await adapter.list({ kind, facilityId, filters, limit: limit + 1, position });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      page: { nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: 1, kind, facilityId, filters,
          position: kind === 'courts'
            ? { facilityName: last.facility.name, courtName: last.name, id: last.id }
            : { name: last.name, id: last.id } })).toString('base64url')
        : null },
    };
  }
}

function decodeCursor(cursor, kind, facilityId, filters) {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const decoded = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(decoded).sort().join(',') !== 'facilityId,filters,kind,position,v'
      || decoded.v !== 1 || decoded.kind !== kind || decoded.facilityId !== facilityId
      || JSON.stringify(decoded.filters) !== JSON.stringify(filters)) throw new Error();
    const p = decoded.position;
    if (!p || typeof p !== 'object' || Array.isArray(p)
      || typeof p.id !== 'string' || !/^[1-9]\d*$/.test(p.id) || BigInt(p.id) > MAX_ID) throw new Error();
    if (kind === 'courts') {
      if (Object.keys(p).sort().join(',') !== 'courtName,facilityName,id'
        || typeof p.facilityName !== 'string' || typeof p.courtName !== 'string'
        || p.facilityName.length > 150 || p.courtName.length > 150) throw new Error();
    } else if (Object.keys(p).sort().join(',') !== 'id,name'
      || typeof p.name !== 'string' || p.name.length > 150) throw new Error();
    return p;
  } catch {
    throw appError('invalid_request', 'The request is invalid', {
      details: [{ field: 'cursor', message: 'Must match this collection and filters' }],
    });
  }
}

function requireAdmin(actor) {
  if (!actor?.roles?.includes('ADMINISTRADOR')) {
    throw appError('forbidden', 'The user cannot perform this operation');
  }
}

function notFound() {
  return appError('resource_not_found', 'The requested resource was not found');
}
