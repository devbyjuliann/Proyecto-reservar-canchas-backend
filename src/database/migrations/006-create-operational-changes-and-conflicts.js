export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE operational_changes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      court_id BIGINT UNSIGNED NOT NULL,
      actor_user_id BIGINT UNSIGNED NOT NULL,
      change_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      metadata JSON NULL,
      PRIMARY KEY (id),
      KEY idx_operational_changes_court_occurred (court_id, occurred_at),
      CONSTRAINT fk_operational_changes_court
        FOREIGN KEY (court_id) REFERENCES courts (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_operational_changes_actor
        FOREIGN KEY (actor_user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE operational_conflicts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      operational_change_id BIGINT UNSIGNED NOT NULL,
      booking_id BIGINT UNSIGNED NOT NULL,
      detected_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      resolved_at DATETIME(6) NULL,
      resolved_by_user_id BIGINT UNSIGNED NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_operational_conflicts_change_booking
        UNIQUE (operational_change_id, booking_id),
      KEY idx_operational_conflicts_booking (booking_id),
      KEY idx_operational_conflicts_resolution (resolved_at, detected_at),
      CONSTRAINT fk_operational_conflicts_change
        FOREIGN KEY (operational_change_id) REFERENCES operational_changes (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_operational_conflicts_booking
        FOREIGN KEY (booking_id) REFERENCES bookings (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_operational_conflicts_resolved_by
        FOREIGN KEY (resolved_by_user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_operational_conflicts_resolution
        CHECK (
          (resolved_at IS NULL AND resolved_by_user_id IS NULL)
          OR
          (resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
        )
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE operational_conflicts');
  await connection.query('DROP TABLE operational_changes');
}
