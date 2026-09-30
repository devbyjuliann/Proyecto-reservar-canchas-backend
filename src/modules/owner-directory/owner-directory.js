import { appError } from '../../shared/errors.js';
import { toInstantString } from '../../shared/time.js';

export function createOwnerDirectoryModule({ adapter, clock }) {
  if (!adapter?.isSuspended || typeof clock?.now !== 'function') {
    throw new TypeError('An owner directory adapter and clock are required');
  }
  return Object.freeze({ listOwners, getOwner, suspendOwner, reactivateOwner, requireActiveOwner });

  async function requireActiveOwner(actor) {
    if (!actor?.roles?.includes('PROPIETARIO')) throw appError('forbidden', 'Owner role is required');
    if (await adapter.isSuspended(String(actor.id))) {
      throw appError('owner_suspended', 'Owner access is suspended');
    }
  }

  async function listOwners({ actor, query, limit, cursor }) {
    requireAdministrator(actor);
    const afterId = cursor ? readCursor(cursor, query) : null;
    const rows = await adapter.listOwners({ query, afterId, limit: limit + 1 });
    const items = rows.slice(0, limit);
    return { items, page: { nextCursor: rows.length > limit
      ? Buffer.from(JSON.stringify({ v: 1, query, afterId: items.at(-1).id })).toString('base64url')
      : null } };
  }

  async function getOwner({ actor, ownerId }) {
    requireAdministrator(actor);
    const owner = await adapter.getOwner(ownerId);
    if (!owner) throw appError('resource_not_found', 'Owner not found');
    return owner;
  }

  async function suspendOwner({ actor, ownerId }) {
    return change(actor, ownerId, true);
  }

  async function reactivateOwner({ actor, ownerId }) {
    return change(actor, ownerId, false);
  }

  async function change(actor, ownerId, suspended) {
    requireAdministrator(actor);
    const result = await adapter.changeSuspension({ ownerId, suspended, now: toInstantString(clock.now()) });
    if (!result) throw appError('resource_not_found', 'Owner not found');
    if (result.owner.deactivatedAt !== null) throw appError('resource_inactive', 'User account is inactive');
    return { owner: result.owner, operation: { changed: result.changed, changes: [] } };
  }
}

function requireAdministrator(actor) {
  if (!actor?.roles?.includes('ADMINISTRADOR')) throw appError('forbidden', 'Administrator role is required');
}

function readCursor(cursor, query) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(value).sort().join(',') !== 'afterId,query,v' || value.v !== 1 || value.query !== query
      || typeof value.afterId !== 'string' || !/^[1-9]\d*$/.test(value.afterId)
      || BigInt(value.afterId) > 18_446_744_073_709_551_615n) throw new Error();
    return value.afterId;
  } catch {
    throw appError('invalid_request', 'The cursor is invalid');
  }
}
