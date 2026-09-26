export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE court_unavailabilities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      court_id BIGINT UNSIGNED NOT NULL,
      type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      start_at DATETIME(6) NOT NULL,
      end_at DATETIME(6) NOT NULL,
      reason VARCHAR(500) NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (id),
      KEY idx_unavailabilities_court_start_end (court_id, start_at, end_at),
      CONSTRAINT fk_unavailabilities_court
        FOREIGN KEY (court_id) REFERENCES courts (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_unavailabilities_created_by
        FOREIGN KEY (created_by_user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_unavailabilities_type
        CHECK (type IN ('BLOQUEO_ADMINISTRATIVO', 'FUERA_DE_SERVICIO')),
      CONSTRAINT chk_unavailabilities_interval
        CHECK (start_at < end_at)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE court_unavailabilities');
}
