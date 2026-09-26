import { appError } from '../../shared/errors.js';

const MESSAGES = Object.freeze({
  invalid_request: 'The request is invalid',
  forbidden: 'The user cannot perform this operation',
  resource_not_found: 'The requested resource was not found',
  invalid_booking_option: 'The selected booking option is invalid',
  option_not_available: 'The selected booking option is not available',
  booking_conflict: 'The selected booking option conflicts with another booking',
  invalid_idempotency_key_reuse: 'The idempotency key was used for another request',
  booking_already_started: 'The booking has already started',
  invalid_booking_state: 'The booking state does not allow this operation',
  resource_inactive: 'The requested resource is inactive',
  future_bookings_prevent_deactivation: 'Confirmed bookings prevent deactivation',
  facility_time_zone_locked: 'The facility time zone cannot be changed',
  invalid_operational_configuration: 'The operational configuration is invalid',
  internal_error: 'An unexpected error occurred',
});

export function bookingError(code, options) {
  return appError(code, MESSAGES[code] ?? MESSAGES.internal_error, options);
}
