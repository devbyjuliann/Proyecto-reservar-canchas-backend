export async function up({ context: connection }) {
  await connection.query(`ALTER TABLE payments
    DROP CONSTRAINT chk_payments_provider,
    DROP CONSTRAINT chk_payments_status,
    ADD COLUMN wompi_transaction_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN provider_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN finalized_at DATETIME(6) NULL,
    ADD COLUMN payment_method_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT chk_payments_provider CHECK (provider IN ('TEST', 'WOMPI')),
    ADD CONSTRAINT chk_payments_status CHECK (status IN ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'FALLIDO', 'EXPIRADO', 'REFUND_PENDING')),
    ADD UNIQUE KEY uq_payments_wompi_transaction (wompi_transaction_id)`);
  await connection.query(`CREATE TABLE payment_provider_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_event_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    received_at DATETIME(6) NOT NULL,
    UNIQUE KEY uq_payment_provider_events (provider, provider_event_id),
    CONSTRAINT chk_payment_provider_events_provider CHECK (provider IN ('WOMPI'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE IF EXISTS payment_provider_events');
  await connection.query(`ALTER TABLE payments
    DROP KEY uq_payments_wompi_transaction,
    DROP CONSTRAINT chk_payments_provider,
    DROP CONSTRAINT chk_payments_status,
    DROP COLUMN payment_method_type,
    DROP COLUMN finalized_at,
    DROP COLUMN provider_status,
    DROP COLUMN wompi_transaction_id,
    ADD CONSTRAINT chk_payments_provider CHECK (provider IN ('TEST')),
    ADD CONSTRAINT chk_payments_status CHECK (status IN ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'FALLIDO', 'EXPIRADO'))`);
}
