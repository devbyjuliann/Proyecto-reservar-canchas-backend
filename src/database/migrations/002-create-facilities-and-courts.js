export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE facilities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      timezone VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      minimum_advance_minutes INT UNSIGNED NOT NULL DEFAULT 15,
      maximum_advance_minutes INT UNSIGNED NOT NULL DEFAULT 43200,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      deactivated_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      CONSTRAINT chk_facilities_advance_window
        CHECK (minimum_advance_minutes <= maximum_advance_minutes),
      CONSTRAINT chk_facilities_deactivated_at
        CHECK (deactivated_at IS NULL OR deactivated_at >= created_at)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE courts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      facility_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(150) NOT NULL,
      description VARCHAR(500) NULL,
      minimum_separation_minutes SMALLINT UNSIGNED NOT NULL,
      start_interval_minutes SMALLINT UNSIGNED NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      deactivated_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      KEY idx_courts_facility_deactivated (facility_id, deactivated_at),
      CONSTRAINT fk_courts_facility
        FOREIGN KEY (facility_id) REFERENCES facilities (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_courts_start_interval
        CHECK (start_interval_minutes > 0),
      CONSTRAINT chk_courts_deactivated_at
        CHECK (deactivated_at IS NULL OR deactivated_at >= created_at)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE courts');
  await connection.query('DROP TABLE facilities');
}
