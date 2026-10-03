export async function up({ context: connection }) {
  await connection.query(`ALTER TABLE courts
    ADD COLUMN deposit_percentage TINYINT UNSIGNED NOT NULL DEFAULT 30,
    ADD CONSTRAINT chk_courts_deposit_percentage CHECK (deposit_percentage BETWEEN 1 AND 100)`);
  await connection.query(`ALTER TABLE bookings
    DROP CONSTRAINT chk_bookings_status,
    DROP CONSTRAINT chk_bookings_cancellation,
    ADD COLUMN deposit_percentage_snapshot TINYINT UNSIGNED NULL,
    ADD COLUMN deposit_amount_minor BIGINT UNSIGNED NULL,
    ADD COLUMN amount_paid_minor BIGINT UNSIGNED NULL,
    ADD COLUMN payment_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN payment_expires_at DATETIME(6) NULL,
    ADD COLUMN voluntary_reschedule_count TINYINT UNSIGNED NULL,
    ADD CONSTRAINT chk_bookings_status CHECK (status IN ('PENDIENTE_PAGO', 'CONFIRMADA', 'CANCELADA')),
    ADD CONSTRAINT chk_bookings_cancellation CHECK (
      (status IN ('PENDIENTE_PAGO', 'CONFIRMADA') AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
      OR (status = 'CANCELADA' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
        AND cancelled_at >= created_at)),
    ADD CONSTRAINT chk_bookings_payment_snapshot CHECK (
      deposit_percentage_snapshot IS NULL OR deposit_percentage_snapshot BETWEEN 1 AND 100),
    ADD KEY idx_bookings_pending_expiry (status, payment_expires_at)`);
  await connection.query(`CREATE TABLE payments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    booking_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    amount_minor BIGINT UNSIGNED NOT NULL,
    currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    purpose VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_reference VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    UNIQUE KEY uq_payments_provider_reference (provider, provider_reference),
    KEY idx_payments_booking (booking_id, id), KEY idx_payments_user (user_id, id),
    CONSTRAINT fk_payments_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT chk_payments_amount CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
    CONSTRAINT chk_payments_currency CHECK (currency = 'COP'),
    CONSTRAINT chk_payments_status CHECK (status IN ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'FALLIDO', 'EXPIRADO')),
    CONSTRAINT chk_payments_purpose CHECK (purpose IN ('DEPOSITO')),
    CONSTRAINT chk_payments_provider CHECK (provider IN ('TEST'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.query(`CREATE TABLE customer_credit_balances (
    facility_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    balance_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (facility_id, user_id),
    CONSTRAINT fk_credit_balance_facility FOREIGN KEY (facility_id) REFERENCES facilities (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_credit_balance_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.query(`CREATE TABLE customer_credit_ledger (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    facility_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    booking_id BIGINT UNSIGNED NULL,
    amount_minor BIGINT NOT NULL,
    reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    KEY idx_credit_ledger_customer (facility_id, user_id, id),
    CONSTRAINT fk_credit_ledger_facility FOREIGN KEY (facility_id) REFERENCES facilities (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_credit_ledger_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_credit_ledger_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT chk_credit_ledger_amount CHECK (amount_minor <> 0),
    CONSTRAINT chk_credit_ledger_reason CHECK (reason IN ('RESCHEDULE_SURPLUS', 'DEPOSIT_CREDIT_APPLIED'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE IF EXISTS customer_credit_ledger');
  await connection.query('DROP TABLE IF EXISTS customer_credit_balances');
  await connection.query('DROP TABLE IF EXISTS payments');
  // Allow a test/development database that applied the prior 018 draft to be reverted.
  const [columns] = await connection.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'bookings'
      AND column_name IN ('payment_expires_at', 'payment_due_at')`);
  const expiryColumn = columns.some((column) => column.column_name === 'payment_expires_at')
    ? 'payment_expires_at'
    : 'payment_due_at';
  await connection.query(`ALTER TABLE bookings
    DROP CONSTRAINT chk_bookings_payment_snapshot,
    DROP CONSTRAINT chk_bookings_cancellation,
    DROP CONSTRAINT chk_bookings_status,
    DROP KEY idx_bookings_pending_expiry,
    DROP COLUMN voluntary_reschedule_count,
    DROP COLUMN ${expiryColumn},
    DROP COLUMN payment_status,
    DROP COLUMN amount_paid_minor,
    DROP COLUMN deposit_amount_minor,
    DROP COLUMN deposit_percentage_snapshot,
    ADD CONSTRAINT chk_bookings_status CHECK (status IN ('CONFIRMADA', 'CANCELADA')),
    ADD CONSTRAINT chk_bookings_cancellation CHECK (
      (status = 'CONFIRMADA' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
      OR (status = 'CANCELADA' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
        AND cancelled_at >= created_at))`);
  await connection.query('ALTER TABLE courts DROP CONSTRAINT chk_courts_deposit_percentage, DROP COLUMN deposit_percentage');
}
