import { appError } from '../../shared/errors.js';

const MESSAGES = Object.freeze({
  invalid_request: 'The request is invalid',
  forbidden: 'The user cannot perform this operation',
  resource_not_found: 'The requested resource was not found',
  invalid_booking_option: 'The selected booking option is invalid',
  option_not_available: 'The selected booking option is not available',
  booking_conflict: 'The selected booking option conflicts with another booking',
  booking_price_changed: 'The price for the selected booking option has changed',
  invalid_idempotency_key_reuse: 'The idempotency key was used for another request',
  booking_already_started: 'The booking has already started',
  booking_not_started: 'The booking has not started',
  booking_cancellation_window_closed: 'The normal cancellation or rescheduling window has closed',
  booking_exception_pending: 'An exception request is already pending',
  invalid_booking_state: 'The booking state does not allow this operation',
  voluntary_reschedule_limit_reached: 'The voluntary reschedule limit has been reached',
  invalid_payment_amount: 'The approved payment amount does not match the checkout amount',
  payment_reference_reused: 'The payment provider reference was already used',
  resource_inactive: 'The requested resource is inactive',
  future_bookings_prevent_deactivation: 'Confirmed bookings prevent deactivation',
  facility_time_zone_locked: 'The facility time zone cannot be changed',
  invalid_operational_configuration: 'The operational configuration is invalid',
  internal_error: 'An unexpected error occurred',
});

export function bookingError(code, options) {
  return appError(code, MESSAGES[code] ?? MESSAGES.internal_error, options);
}
