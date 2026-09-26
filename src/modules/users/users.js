import {
  UserEmailAlreadyExistsError,
  UserNotFoundError,
  UsersForbiddenError,
} from './errors.js';
import {
  normalizeEmail,
  validateCreateUserInput,
  validateRole,
  validateUserId,
} from './validation.js';

export function createUsersModule({ adapter }) {
  if (!adapter) {
    throw new TypeError('A users adapter is required');
  }

  return Object.freeze({ createUser, findById, assignRole });

  async function createUser(input) {
    const user = validateCreateUserInput(input);

    try {
      return await adapter.createUser(user);
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new UserEmailAlreadyExistsError();
      }
      throw error;
    }
  }

  async function findById({ actor, userId }) {
    const actorUser = await loadActor(actor);
    const targetUserId = validateUserId(userId);

    if (
      String(actorUser.id) !== String(targetUserId) &&
      !actorUser.roles.includes('ADMINISTRADOR')
    ) {
      throw new UsersForbiddenError();
    }

    const user = await adapter.findById(targetUserId);
    if (!user) {
      throw new UserNotFoundError();
    }
    return user;
  }

  async function assignRole({ actor, userId, role }) {
    const actorUser = await loadActor(actor);
    if (!actorUser.roles.includes('ADMINISTRADOR')) {
      throw new UsersForbiddenError();
    }

    const targetUserId = validateUserId(userId);
    const roleCode = validateRole(role);
    const user = await adapter.assignRole(targetUserId, roleCode);
    if (!user) {
      throw new UserNotFoundError();
    }
    return user;
  }

  async function loadActor(actor) {
    const actorId = validateUserId(actor?.userId);
    const actorUser = await adapter.findById(actorId);
    if (!actorUser) {
      throw new UsersForbiddenError();
    }
    return actorUser;
  }
}

export { normalizeEmail };
