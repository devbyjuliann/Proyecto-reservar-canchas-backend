import mysql from 'mysql2/promise';

import { loadDatabaseConfig } from '../config/database.js';

export async function createMigrationConnection(
  config = loadDatabaseConfig({ forMigrations: true }),
) {
  let connection;

  try {
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: 'utf8mb4',
      timezone: 'Z',
      multipleStatements: false,
    });

    await connection.query(
      'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
    );
    await connection.query("SET SESSION time_zone = '+00:00'");

    return connection;
  } catch (error) {
    if (connection) {
      await connection.end();
    }

    throw error;
  }
}
