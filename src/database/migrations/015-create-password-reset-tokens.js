export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE password_reset_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash BINARY(32) NOT NULL,
      created_at DATETIME(6) NOT NULL,
      expires_at DATETIME(6) NOT NULL,
      consumed_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_password_reset_token_hash UNIQUE (token_hash),
      KEY idx_password_reset_user (user_id, consumed_at),
      KEY idx_password_reset_expiration (expires_at),
      CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_password_reset_expiration CHECK (expires_at > created_at),
      CONSTRAINT chk_password_reset_consumed CHECK (consumed_at IS NULL OR consumed_at >= created_at)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE password_reset_tokens');
}
