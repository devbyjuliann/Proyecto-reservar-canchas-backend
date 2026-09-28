import { toInstantString } from '../../shared/time.js';
import { appError } from '../../shared/errors.js';

const MAX_ID = 18_446_744_073_709_551_615n;

export function createOwnerApplicationsModule({ adapter, clock }) {
  if (!adapter || typeof clock?.now !== 'function') {
    throw new TypeError('An owner applications adapter and clock are required');
  }

  return Object.freeze({ create, listOwn, getOwn, listAdmin, getAdmin, approve, reject });

  async function create({ actor, businessName, message }) {
    const result = await adapter.create({
      userId: String(actor.id), businessName, message: message ?? null,
      now: toInstantString(clock.now()),
    });
    if (result === 'already_owner') throw error('already_owner');
    if (result === 'owner_application_pending') throw error('owner_application_pending');
    if (result === 'inactive') throw error('authentication_required');
    return result;
  }

  async function listOwn({ actor, limit, cursor }) {
    return paginated('own', String(actor.id), undefined, limit, cursor);
  }

  async function getOwn({ actor, applicationId }) {
    const result = await adapter.get({ applicationId, userId: String(actor.id) });
    if (!result) throw error('resource_not_found');
    return result;
  }

  async function listAdmin({ actor, status, limit, cursor }) {
    requireAdministrator(actor);
    return paginated('admin', undefined, status, limit, cursor);
  }

  async function getAdmin({ actor, applicationId }) {
    requireAdministrator(actor);
    const result = await adapter.get({ applicationId });
    if (!result) throw error('resource_not_found');
    return result;
  }

  async function approve({ actor, applicationId }) {
    requireAdministrator(actor);
    const result = await adapter.decide({
      applicationId, reviewerId: String(actor.id), decision: 'APROBADA',
      now: toInstantString(clock.now()),
    });
    return decided(result);
  }

  async function reject({ actor, applicationId, reason }) {
    requireAdministrator(actor);
    const result = await adapter.decide({
      applicationId, reviewerId: String(actor.id), decision: 'RECHAZADA', reason,
      now: toInstantString(clock.now()),
    });
    return decided(result);
  }

  function decided(result) {
    if (result === 'invalid_owner_application_state') throw error(result);
    if (result === 'forbidden') throw error(result);
    if (!result) throw error('resource_not_found');
    return result;
  }

  async function paginated(kind, userId, status, limit, cursor) {
    const position = cursor ? decodeCursor(cursor, kind, userId, status) : null;
    const rows = await adapter.list({ kind, userId, status, limit: limit + 1, position });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      page: {
        nextCursor: rows.length > limit && last
          ? Buffer.from(JSON.stringify({ v: 1, kind, userId: userId ?? null,
            status: status ?? null, createdAt: last.createdAt, id: last.id })).toString('base64url')
          : null,
      },
    };
  }
}

function decodeCursor(cursor, kind, userId, status) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(value).sort().join(',') !== 'createdAt,id,kind,status,userId,v'
      || value.v !== 1 || value.kind !== kind
      || value.userId !== (userId ?? null) || value.status !== (status ?? null)
      || typeof value.id !== 'string' || !/^[1-9]\d*$/.test(value.id)
      || BigInt(value.id) > MAX_ID || toInstantString(value.createdAt) !== value.createdAt) {
      throw new Error();
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw appError('invalid_request', 'The request is invalid', {
      details: [{ field: 'cursor', message: 'Must match this collection and filters' }],
    });
  }
}

function requireAdministrator(actor) {
  if (!actor?.roles?.includes('ADMINISTRADOR')) throw error('forbidden');
}

function error(code) {
  return appError(code, ({
    already_owner: 'The user is already an owner',
    owner_application_pending: 'An owner application is already pending',
    invalid_owner_application_state: 'The owner application has already been decided',
    forbidden: 'The user cannot perform this operation',
    resource_not_found: 'The requested resource was not found',
    authentication_required: 'Authentication is required',
  })[code]);
}
