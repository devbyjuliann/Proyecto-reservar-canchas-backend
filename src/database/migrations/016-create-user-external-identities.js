export async function up({ context: connection }) {
  await connection.query(`
    CREATE TABLE user_external_identities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      provider_subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_external_provider_subject UNIQUE (provider, provider_subject),
      CONSTRAINT uq_external_user_provider UNIQUE (user_id, provider),
      CONSTRAINT fk_external_identity_user FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_external_identity_provider CHECK (provider = 'GOOGLE'),
      CONSTRAINT chk_external_identity_subject CHECK (CHAR_LENGTH(provider_subject) > 0)
    ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down({ context: connection }) {
  await connection.query('DROP TABLE user_external_identities');
}
