export async function up({ context: connection }) {
  await connection.query(`ALTER TABLE courts
    ADD COLUMN cancellation_min_minutes INT UNSIGNED NOT NULL DEFAULT 120`);
  await connection.query(`ALTER TABLE bookings
    ADD COLUMN cancellation_min_minutes INT UNSIGNED NOT NULL DEFAULT 120,
    ADD COLUMN cancellation_reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN economic_outcome VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN no_show_at DATETIME(6) NULL,
    ADD COLUMN no_show_by_user_id BIGINT UNSIGNED NULL,
    ADD CONSTRAINT fk_bookings_no_show_actor FOREIGN KEY (no_show_by_user_id) REFERENCES users (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT chk_bookings_cancellation_reason CHECK (
      cancellation_reason IS NULL OR cancellation_reason IN ('CLIENTE_A_TIEMPO', 'CLIENTE_EXCEPCION', 'CANCELLED_BY_OWNER')),
    ADD CONSTRAINT chk_bookings_economic_outcome CHECK (
      economic_outcome IS NULL OR economic_outcome IN
        ('REFUND_ALLOWED', 'NON_REFUNDABLE', 'RESCHEDULE_PRIORITY',
         'FULL_REFUND_OR_RESCHEDULE', 'NOT_APPLICABLE')),
    ADD CONSTRAINT chk_bookings_no_show CHECK (
      (no_show_at IS NULL AND no_show_by_user_id IS NULL) OR
      (no_show_at IS NOT NULL AND no_show_by_user_id IS NOT NULL AND status = 'CONFIRMADA'))`);
  await connection.query(`CREATE TABLE booking_changes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    booking_id BIGINT UNSIGNED NOT NULL,
    change_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_user_id BIGINT UNSIGNED NOT NULL,
    previous_start_at DATETIME(6) NULL,
    previous_end_at DATETIME(6) NULL,
    new_start_at DATETIME(6) NULL,
    new_end_at DATETIME(6) NULL,
    previous_price_minor BIGINT UNSIGNED NULL,
    new_price_minor BIGINT UNSIGNED NULL,
    reason_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reason VARCHAR(500) NULL,
    economic_outcome VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    CONSTRAINT fk_booking_changes_booking FOREIGN KEY (booking_id) REFERENCES bookings (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_booking_changes_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT chk_booking_changes_type CHECK (change_type IN
      ('CREATED', 'RESCHEDULED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_OWNER', 'NO_SHOW')),
    CONSTRAINT chk_booking_changes_economic CHECK (economic_outcome IN
      ('REFUND_ALLOWED', 'NON_REFUNDABLE', 'RESCHEDULE_PRIORITY',
       'FULL_REFUND_OR_RESCHEDULE', 'NOT_APPLICABLE')),
    CONSTRAINT chk_booking_changes_reason CHECK (reason_code IS NULL OR reason_code IN
      ('COURT_DAMAGE', 'URGENT_MAINTENANCE', 'UNEXPECTED_CLOSURE', 'EXTRAORDINARY_UNAVAILABILITY')),
    KEY idx_booking_changes_booking (booking_id, created_at, id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.query(`CREATE TABLE booking_exception_requests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    booking_id BIGINT UNSIGNED NOT NULL,
    category VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    note VARCHAR(500) NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    requested_by_user_id BIGINT UNSIGNED NOT NULL,
    requested_at DATETIME(6) NOT NULL,
    resolved_by_user_id BIGINT UNSIGNED NULL,
    resolved_at DATETIME(6) NULL,
    used_at DATETIME(6) NULL,
    economic_outcome VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'NOT_APPLICABLE',
    CONSTRAINT fk_booking_exception_booking FOREIGN KEY (booking_id) REFERENCES bookings (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_booking_exception_requester FOREIGN KEY (requested_by_user_id) REFERENCES users (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_booking_exception_resolver FOREIGN KEY (resolved_by_user_id) REFERENCES users (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT chk_booking_exception_category CHECK (category IN ('MAL_CLIMA', 'FUERZA_MAYOR')),
    CONSTRAINT chk_booking_exception_status CHECK (status IN ('PENDIENTE', 'APROBADA', 'RECHAZADA')),
    CONSTRAINT chk_booking_exception_economic CHECK (economic_outcome IN
      ('NOT_APPLICABLE', 'RESCHEDULE_PRIORITY', 'REFUND_ALLOWED')),
    CONSTRAINT chk_booking_exception_resolution CHECK (
      (status = 'PENDIENTE' AND resolved_by_user_id IS NULL AND resolved_at IS NULL AND used_at IS NULL)
      OR (status <> 'PENDIENTE' AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL)),
    KEY idx_booking_exception_booking (booking_id, status, id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.query(`ALTER TABLE idempotency_records
    DROP CONSTRAINT chk_idempotency_operation,
    ADD CONSTRAINT chk_idempotency_operation CHECK (operation IN ('CONFIRM_BOOKING', 'BOOKING_RESCHEDULE'))`);
}

export async function down({ context: connection }) {
  await connection.query(`ALTER TABLE idempotency_records
    DROP CONSTRAINT chk_idempotency_operation,
    ADD CONSTRAINT chk_idempotency_operation CHECK (operation = 'CONFIRM_BOOKING')`);
  await connection.query('DROP TABLE booking_exception_requests');
  await connection.query('DROP TABLE booking_changes');
  await connection.query(`ALTER TABLE bookings
    DROP CONSTRAINT chk_bookings_no_show,
    DROP CONSTRAINT chk_bookings_economic_outcome,
    DROP CONSTRAINT chk_bookings_cancellation_reason,
    DROP FOREIGN KEY fk_bookings_no_show_actor,
    DROP COLUMN no_show_by_user_id,
    DROP COLUMN no_show_at,
    DROP COLUMN economic_outcome,
    DROP COLUMN cancellation_reason,
    DROP COLUMN cancellation_min_minutes`);
  await connection.query('ALTER TABLE courts DROP COLUMN cancellation_min_minutes');
}
