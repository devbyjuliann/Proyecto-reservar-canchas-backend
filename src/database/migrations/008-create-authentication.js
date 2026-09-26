export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE user_credentials (
      user_id BIGINT UNSIGNED NOT NULL,
      password_hash VARBINARY(64) NOT NULL,
      password_salt VARBINARY(32) NOT NULL,
      algorithm VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      scrypt_cost INT UNSIGNED NOT NULL,
      scrypt_block_size INT UNSIGNED NOT NULL,
      scrypt_parallelization INT UNSIGNED NOT NULL,
      created_at DATETIME(6) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_user_credentials_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_user_credentials_algorithm
        CHECK (algorithm = 'SCRYPT'),
      CONSTRAINT chk_user_credentials_hash_length
        CHECK (OCTET_LENGTH(password_hash) = 64),
      CONSTRAINT chk_user_credentials_salt_length
        CHECK (OCTET_LENGTH(password_salt) >= 16),
      CONSTRAINT chk_user_credentials_parameters
        CHECK (scrypt_cost > 1 AND scrypt_block_size > 0 AND scrypt_parallelization > 0),
      CONSTRAINT chk_user_credentials_updated_at
        CHECK (updated_at >= created_at)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash BINARY(32) NOT NULL,
      created_at DATETIME(6) NOT NULL,
      expires_at DATETIME(6) NOT NULL,
      revoked_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_sessions_token_hash UNIQUE (token_hash),
      KEY idx_sessions_user_state (user_id, revoked_at, expires_at),
      KEY idx_sessions_expiration (expires_at),
      CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_sessions_expiration
        CHECK (expires_at > created_at),
      CONSTRAINT chk_sessions_revocation
        CHECK (revoked_at IS NULL OR revoked_at >= created_at)
    ) ENGINE=InnoDB
      DEFAULT CHARACTER SET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE sessions');
  await connection.query('DROP TABLE user_credentials');
}
