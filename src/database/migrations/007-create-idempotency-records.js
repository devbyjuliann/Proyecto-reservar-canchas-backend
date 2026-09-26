export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE idempotency_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      operation VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      idempotency_key VARBINARY(128) NOT NULL,
      request_hash BINARY(32) NOT NULL,
      outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
      booking_id BIGINT UNSIGNED NULL,
      result_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      completed_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_idempotency_user_operation_key
        UNIQUE (user_id, operation, idempotency_key),
      CONSTRAINT fk_idempotency_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_idempotency_booking
        FOREIGN KEY (booking_id) REFERENCES bookings (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_idempotency_operation
        CHECK (operation = 'CONFIRM_BOOKING'),
      CONSTRAINT chk_idempotency_outcome
        CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED', 'REJECTED')),
      CONSTRAINT chk_idempotency_result
        CHECK (
          (outcome IS NULL
            AND booking_id IS NULL
            AND result_code IS NULL
            AND completed_at IS NULL)
          OR
          (outcome = 'SUCCEEDED'
            AND booking_id IS NOT NULL
            AND completed_at IS NOT NULL
            AND completed_at >= created_at)
          OR
          (outcome = 'REJECTED'
            AND booking_id IS NULL
            AND result_code IS NOT NULL
            AND completed_at IS NOT NULL
            AND completed_at >= created_at)
        )
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE idempotency_records');
}
