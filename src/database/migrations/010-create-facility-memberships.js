export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE facility_memberships (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      facility_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      membership_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      active TINYINT UNSIGNED NOT NULL,
      created_at DATETIME(6) NOT NULL,
      deactivated_at DATETIME(6) NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      active_user_id BIGINT UNSIGNED
        GENERATED ALWAYS AS (CASE WHEN active = 1 THEN user_id ELSE NULL END) STORED,
      PRIMARY KEY (id),
      CONSTRAINT uq_memberships_active_facility_user UNIQUE (facility_id, active_user_id),
      KEY idx_memberships_facility_created (facility_id, created_at, id),
      KEY idx_memberships_user_active (user_id, active, facility_id),
      CONSTRAINT fk_memberships_facility FOREIGN KEY (facility_id) REFERENCES facilities (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_memberships_user FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_memberships_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_memberships_type CHECK (membership_type = 'PROPIETARIO'),
      CONSTRAINT chk_memberships_state CHECK (
        (active = 1 AND deactivated_at IS NULL)
        OR (active = 0 AND deactivated_at IS NOT NULL AND deactivated_at >= created_at)
      )
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE facility_memberships');
}
