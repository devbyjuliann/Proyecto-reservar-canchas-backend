export async function up({ context: connection }) {
  await connection.query(`
    ALTER TABLE user_roles
      DROP CONSTRAINT chk_user_roles_role_code,
      ADD CONSTRAINT chk_user_roles_role_code
        CHECK (role_code IN ('USUARIO', 'PROPIETARIO', 'ADMINISTRADOR'))
  `);

  await connection.query(`
    CREATE TABLE owner_applications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      business_name VARCHAR(150) NOT NULL,
      message VARCHAR(1000) NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(6) NOT NULL,
      decided_at DATETIME(6) NULL,
      decided_by_user_id BIGINT UNSIGNED NULL,
      rejection_reason VARCHAR(500) NULL,
      pending_user_id BIGINT UNSIGNED
        GENERATED ALWAYS AS (CASE WHEN status = 'PENDIENTE' THEN user_id ELSE NULL END) STORED,
      PRIMARY KEY (id),
      CONSTRAINT uq_owner_applications_pending_user UNIQUE (pending_user_id),
      KEY idx_owner_applications_status_created_id (status, created_at, id),
      KEY idx_owner_applications_user_created_id (user_id, created_at, id),
      CONSTRAINT fk_owner_applications_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_owner_applications_reviewer
        FOREIGN KEY (decided_by_user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_owner_applications_status
        CHECK (status IN ('PENDIENTE', 'APROBADA', 'RECHAZADA')),
      CONSTRAINT chk_owner_applications_decision
        CHECK (
          (status = 'PENDIENTE' AND decided_at IS NULL
            AND decided_by_user_id IS NULL AND rejection_reason IS NULL)
          OR
          (status = 'APROBADA' AND decided_at IS NOT NULL
            AND decided_by_user_id IS NOT NULL AND rejection_reason IS NULL)
          OR
          (status = 'RECHAZADA' AND decided_at IS NOT NULL
            AND decided_by_user_id IS NOT NULL AND rejection_reason IS NOT NULL
            AND CHAR_LENGTH(TRIM(rejection_reason)) > 0)
        ),
      CONSTRAINT chk_owner_applications_decision_time
        CHECK (decided_at IS NULL OR decided_at >= created_at),
      CONSTRAINT chk_owner_applications_reviewer_is_other
        CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> user_id)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE owner_applications');
  await connection.query(`
    ALTER TABLE user_roles
      DROP CONSTRAINT chk_user_roles_role_code,
      ADD CONSTRAINT chk_user_roles_role_code
        CHECK (role_code IN ('USUARIO', 'ADMINISTRADOR'))
  `);
}
