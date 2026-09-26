import { appError } from '../../shared/errors.js';

const MESSAGES = Object.freeze({
  invalid_request: 'The request is invalid',
  authentication_required: 'Authentication is required',
  forbidden: 'The user cannot perform this operation',
  resource_not_found: 'The requested resource was not found',
  resource_inactive: 'The resource is inactive',
});

export function facilitiesError(code, options) {
  return appError(code, MESSAGES[code], options);
}
