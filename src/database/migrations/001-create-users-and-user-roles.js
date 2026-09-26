export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      deactivated_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_users_email UNIQUE (email),
      CONSTRAINT chk_users_deactivated_at
        CHECK (deactivated_at IS NULL OR deactivated_at >= created_at)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE user_roles (
      user_id BIGINT UNSIGNED NOT NULL,
      role_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      PRIMARY KEY (user_id, role_code),
      KEY idx_user_roles_role_code (role_code),
      CONSTRAINT fk_user_roles_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_user_roles_role_code
        CHECK (role_code IN ('USUARIO', 'ADMINISTRADOR'))
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE user_roles');
  await connection.query('DROP TABLE users');
}
