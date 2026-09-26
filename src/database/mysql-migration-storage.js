const HISTORY_TABLE = 'schema_migrations';

export class MySqlMigrationStorage {
  #initialized = false;

  async #ensureTable(connection) {
    if (this.#initialized) {
      return;
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        executed_at DATETIME(6) NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_schema_migrations_name UNIQUE (name)
      ) ENGINE=InnoDB
        DEFAULT CHARACTER SET=utf8mb4
        COLLATE=utf8mb4_unicode_ci
    `);

    this.#initialized = true;
  }

  async executed({ context: connection }) {
    await this.#ensureTable(connection);

    const [rows] = await connection.query(
      `SELECT name FROM ${HISTORY_TABLE} ORDER BY id ASC`,
    );

    return rows.map(({ name }) => name);
  }

  async logMigration({ name, context: connection }) {
    await this.#ensureTable(connection);
    await connection.execute(
      `INSERT INTO ${HISTORY_TABLE} (name, executed_at) VALUES (?, UTC_TIMESTAMP(6))`,
      [name],
    );
  }

  async unlogMigration({ name, context: connection }) {
    await this.#ensureTable(connection);

    const [result] = await connection.execute(
      `DELETE FROM ${HISTORY_TABLE} WHERE name = ?`,
      [name],
    );

    if (result.affectedRows !== 1) {
      throw new Error(`Migration history entry not found: ${name}`);
    }
  }
}
