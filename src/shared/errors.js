export class ApplicationError extends Error {
  constructor(code, message, { details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  authentication_required: 401,
  invalid_credentials: 401,
  forbidden: 403,
  origin_not_allowed: 403,
  resource_not_found: 404,
  invalid_booking_option: 422,
  option_not_available: 409,
  booking_conflict: 409,
  booking_price_changed: 409,
  invalid_idempotency_key_reuse: 409,
  booking_already_started: 409,
  invalid_booking_state: 409,
  resource_inactive: 409,
  future_bookings_prevent_deactivation: 409,
  facility_time_zone_locked: 409,
  email_already_registered: 409,
  administrator_already_exists: 409,
  owner_application_pending: 409,
  already_owner: 409,
  invalid_owner_application_state: 409,
  membership_conflict: 409,
  facility_not_publishable: 409,
  invalid_operational_configuration: 422,
  rate_limit_exceeded: 429,
  internal_error: 500,
});

export function appError(code, message, options) {
  return new ApplicationError(code, message, options);
}
