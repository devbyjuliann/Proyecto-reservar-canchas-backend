export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE bookings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      court_id BIGINT UNSIGNED NOT NULL,
      start_at DATETIME(6) NOT NULL,
      end_at DATETIME(6) NOT NULL,
      booking_timezone VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      cancelled_at DATETIME(6) NULL,
      cancelled_by_user_id BIGINT UNSIGNED NULL,
      PRIMARY KEY (id),
      KEY idx_bookings_court_status_start_end
        (court_id, status, start_at, end_at),
      KEY idx_bookings_court_status_end
        (court_id, status, end_at),
      KEY idx_bookings_user_start_id
        (user_id, start_at, id),
      CONSTRAINT fk_bookings_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_bookings_court
        FOREIGN KEY (court_id) REFERENCES courts (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_bookings_cancelled_by
        FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_bookings_interval
        CHECK (start_at < end_at),
      CONSTRAINT chk_bookings_status
        CHECK (status IN ('CONFIRMADA', 'CANCELADA')),
      CONSTRAINT chk_bookings_cancellation
        CHECK (
          (status = 'CONFIRMADA'
            AND cancelled_at IS NULL
            AND cancelled_by_user_id IS NULL)
          OR
          (status = 'CANCELADA'
            AND cancelled_at IS NOT NULL
            AND cancelled_by_user_id IS NOT NULL
            AND cancelled_at >= created_at)
        )
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE bookings');
}
