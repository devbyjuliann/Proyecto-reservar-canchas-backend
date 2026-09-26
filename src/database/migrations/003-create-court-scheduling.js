export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE court_weekly_periods (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      court_id BIGINT UNSIGNED NOT NULL,
      weekday TINYINT UNSIGNED NOT NULL,
      start_time TIME(0) NOT NULL,
      end_time TIME(0) NOT NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_weekly_periods_court_day_start
        UNIQUE (court_id, weekday, start_time),
      CONSTRAINT fk_weekly_periods_court
        FOREIGN KEY (court_id) REFERENCES courts (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_weekly_periods_weekday
        CHECK (weekday BETWEEN 1 AND 7),
      CONSTRAINT chk_weekly_periods_interval
        CHECK (start_time < end_time)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE court_date_exceptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      court_id BIGINT UNSIGNED NOT NULL,
      local_date DATE NOT NULL,
      mode VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_date_exceptions_court_date UNIQUE (court_id, local_date),
      CONSTRAINT fk_date_exceptions_court
        FOREIGN KEY (court_id) REFERENCES courts (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_date_exceptions_mode
        CHECK (mode IN ('CLOSED', 'CUSTOM_PERIODS'))
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE court_exception_periods (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      exception_id BIGINT UNSIGNED NOT NULL,
      start_time TIME(0) NOT NULL,
      end_time TIME(0) NOT NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_exception_periods_exception_start
        UNIQUE (exception_id, start_time),
      CONSTRAINT fk_exception_periods_exception
        FOREIGN KEY (exception_id) REFERENCES court_date_exceptions (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_exception_periods_interval
        CHECK (start_time < end_time)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE court_allowed_durations (
      court_id BIGINT UNSIGNED NOT NULL,
      duration_minutes SMALLINT UNSIGNED NOT NULL,
      PRIMARY KEY (court_id, duration_minutes),
      CONSTRAINT fk_allowed_durations_court
        FOREIGN KEY (court_id) REFERENCES courts (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_allowed_durations_positive
        CHECK (duration_minutes > 0)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE court_allowed_durations');
  await connection.query('DROP TABLE court_exception_periods');
  await connection.query('DROP TABLE court_date_exceptions');
  await connection.query('DROP TABLE court_weekly_periods');
}
