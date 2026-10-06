export async function up({ context: connection }) {
  await connection.query(`CREATE TABLE payment_refunds (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    booking_id BIGINT UNSIGNED NOT NULL,
    payment_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_refund_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    provider_transaction_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    amount_minor BIGINT UNSIGNED NOT NULL,
    currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
    requested_at DATETIME(6) NOT NULL,
    processed_at DATETIME(6) NULL,
    status_message VARCHAR(160) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    last_attempt_at DATETIME(6) NULL,
    emailed_at DATETIME(6) NULL,
    UNIQUE KEY uq_refund_reference (reference),
    UNIQUE KEY uq_refund_provider_id (provider, provider_refund_id),
    UNIQUE KEY uq_refund_obligation (payment_id, reason_code),
    KEY idx_refunds_booking (booking_id, id),
    KEY idx_refunds_pending (status, last_attempt_at),
    CONSTRAINT fk_refund_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE RESTRICT,
    CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE RESTRICT,
    CONSTRAINT fk_refund_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT chk_refund_amount CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
    CONSTRAINT chk_refund_currency CHECK (currency = 'COP'),
    CONSTRAINT chk_refund_provider CHECK (provider = 'WOMPI'),
    CONSTRAINT chk_refund_status CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'CANCELLED')),
    CONSTRAINT chk_refund_reason CHECK (reason_code IN ('LATE_PAYMENT', 'OWNER_CANCELLATION', 'WEATHER_EXCEPTION'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.query(`ALTER TABLE customer_credit_ledger
    DROP CONSTRAINT chk_credit_ledger_reason,
    ADD CONSTRAINT chk_credit_ledger_reason CHECK (reason IN
      ('RESCHEDULE_SURPLUS', 'DEPOSIT_CREDIT_APPLIED', 'CREDIT_RESTORED')),
    ADD COLUMN restoration_booking_id BIGINT UNSIGNED GENERATED ALWAYS AS
      (CASE WHEN reason = 'CREDIT_RESTORED' THEN booking_id ELSE NULL END) STORED,
    ADD UNIQUE KEY uq_credit_restoration (restoration_booking_id)`);
  await connection.query(`ALTER TABLE bookings
    ADD COLUMN economic_resolution VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT chk_bookings_resolution CHECK
      (economic_resolution IS NULL OR economic_resolution IN ('REFUND_REQUESTED', 'RESCHEDULED'))`);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE payment_refunds');
  await connection.query('ALTER TABLE bookings DROP CONSTRAINT chk_bookings_resolution, DROP COLUMN economic_resolution');
  await connection.query(`ALTER TABLE customer_credit_ledger DROP KEY uq_credit_restoration,
    DROP COLUMN restoration_booking_id,
    DROP CONSTRAINT chk_credit_ledger_reason,
    ADD CONSTRAINT chk_credit_ledger_reason CHECK (reason IN ('RESCHEDULE_SURPLUS', 'DEPOSIT_CREDIT_APPLIED'))`);
}
