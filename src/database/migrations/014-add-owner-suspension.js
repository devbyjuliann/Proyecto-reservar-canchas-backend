export async function up({ context: connection }) {
  await connection.query(`
    ALTER TABLE users
      ADD COLUMN owner_suspended_at DATETIME(6) NULL,
      ADD CONSTRAINT chk_users_owner_suspended_at
        CHECK (owner_suspended_at IS NULL OR owner_suspended_at >= created_at)
  `);
}

export async function down({ context: connection }) {
  await connection.query(`
    ALTER TABLE users
      DROP CONSTRAINT chk_users_owner_suspended_at,
      DROP COLUMN owner_suspended_at
  `);
}
