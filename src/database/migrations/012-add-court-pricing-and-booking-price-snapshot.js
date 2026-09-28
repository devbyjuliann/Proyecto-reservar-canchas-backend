export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE court_prices (
      court_id BIGINT UNSIGNED NOT NULL,
      duration_minutes SMALLINT UNSIGNED NOT NULL,
      price_amount_minor BIGINT UNSIGNED NOT NULL,
      currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      PRIMARY KEY (court_id, duration_minutes),
      KEY idx_court_prices_amount (price_amount_minor, court_id),
      CONSTRAINT fk_court_prices_duration
        FOREIGN KEY (court_id, duration_minutes)
        REFERENCES court_allowed_durations (court_id, duration_minutes)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_court_prices_amount
        CHECK (price_amount_minor BETWEEN 1 AND 9007199254740991),
      CONSTRAINT chk_court_prices_currency CHECK (currency = 'COP')
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    ALTER TABLE bookings
      ADD COLUMN price_amount_minor BIGINT UNSIGNED NULL,
      ADD COLUMN price_currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD CONSTRAINT chk_bookings_price_snapshot CHECK (
        (price_amount_minor IS NULL AND price_currency IS NULL)
        OR (price_amount_minor BETWEEN 1 AND 9007199254740991 AND price_currency = 'COP')
      )
  `);

  await connection.query(`
    ALTER TABLE idempotency_records
      ADD COLUMN result_price_amount_minor BIGINT UNSIGNED NULL,
      ADD COLUMN result_price_currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD CONSTRAINT chk_idempotency_result_price CHECK (
        (result_price_amount_minor IS NULL AND result_price_currency IS NULL)
        OR (result_price_amount_minor BETWEEN 1 AND 9007199254740991
          AND result_price_currency = 'COP' AND outcome = 'REJECTED'
          AND result_code = 'booking_price_changed')
      )
  `);
}

export async function down({ context: connection }) {
  await connection.query(`
    ALTER TABLE idempotency_records
      DROP CONSTRAINT chk_idempotency_result_price,
      DROP COLUMN result_price_amount_minor,
      DROP COLUMN result_price_currency
  `);
  await connection.query(`
    ALTER TABLE bookings
      DROP CONSTRAINT chk_bookings_price_snapshot,
      DROP COLUMN price_amount_minor,
      DROP COLUMN price_currency
  `);
  await connection.query('DROP TABLE court_prices');
}
