import mysql from 'mysql2/promise';

import { loadDatabaseConfig } from '../config/database.js';

export function createMySqlPool(config = loadDatabaseConfig()) {
  const rawPool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  async function getConnection() {
    const connection = await rawPool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.query(
        'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
      );
      return connection;
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  async function execute(sql, values) {
    const connection = await getConnection();
    try {
      return await connection.execute(sql, values);
    } finally {
      connection.release();
    }
  }

  return Object.freeze({
    execute,
    getConnection,
    end: () => rawPool.end(),
  });
}
