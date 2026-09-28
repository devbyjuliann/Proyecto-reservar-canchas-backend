import { appError } from '../../shared/errors.js';

export function createCourtPricingModule({ adapter, memberships }) {
  if (!adapter || !memberships?.requireMembership) {
    throw new TypeError('A court pricing adapter and membership authorization are required');
  }
  return Object.freeze({ listPrices, setPrice, removePrice });

  async function authorize({ actor, courtId, scope }) {
    if (scope === 'admin') {
      if (!actor?.roles?.includes('ADMINISTRADOR')) throw error('forbidden');
    } else if (scope !== 'owner') {
      throw error('forbidden');
    } else if (!actor?.roles?.includes('PROPIETARIO')) {
      throw error('forbidden');
    }
    const court = await adapter.getCourt(courtId);
    if (!court) throw error('resource_not_found');
    if (scope === 'owner') {
      await memberships.requireMembership({ actor, facilityId: court.facilityId });
    }
    return { courtId, actorUserId: String(actor.id), scope };
  }

  async function listPrices({ actor, courtId, scope }) {
    const input = await authorize({ actor, courtId, scope });
    return { items: await adapter.listPrices(input) };
  }

  async function setPrice({ actor, courtId, durationMinutes, priceMinor, scope }) {
    const input = await authorize({ actor, courtId, scope });
    const result = await adapter.setPrice({ ...input, durationMinutes, priceMinor });
    return outcome(result);
  }

  async function removePrice({ actor, courtId, durationMinutes, scope }) {
    const input = await authorize({ actor, courtId, scope });
    const result = await adapter.removePrice({ ...input, durationMinutes });
    return outcome(result);
  }
}

function outcome(result) {
  if (typeof result === 'string') throw error(result);
  return { price: result.price, operation: { changed: result.changed, changes: [] } };
}

function error(code) {
  return appError(code, ({
    forbidden: 'The user cannot perform this operation',
    resource_not_found: 'The requested resource was not found',
    resource_inactive: 'The requested resource is inactive',
    invalid_operational_configuration: 'The duration is not allowed for this court',
  })[code]);
}
