import { appError } from '../../shared/errors.js';

// Use the same persisted membership rule inside court/facility transactions.
// Locking the membership serializes a concurrent administrative revocation.
export async function requireActiveMembership(executor, { facilityId, userId, lock = false }) {
  const [rows] = await executor.execute(
    `SELECT m.id FROM facility_memberships m
     JOIN users u ON u.id = m.user_id AND u.deactivated_at IS NULL
     JOIN user_roles r ON r.user_id = u.id AND r.role_code = 'PROPIETARIO'
     WHERE m.facility_id = ? AND m.user_id = ? AND m.active = 1
     ${lock ? 'FOR UPDATE' : ''}`,
    [facilityId, userId],
  );
  if (!rows.length) throw appError('resource_not_found', 'The requested resource was not found');
}
