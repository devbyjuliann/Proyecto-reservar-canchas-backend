import { createHash } from 'node:crypto';

import { loadDatabaseConfig } from '../config/database.js';
import { createMigrator } from './migrator.js';
import { createMigrationConnection } from './mysql.js';

const LOCK_TIMEOUT_SECONDS = 30;
const SUPPORTED_COMMANDS = new Set(['up', 'down', 'status']);

function migrationLockName(database) {
  const databaseHash = createHash('sha256')
    .update(database)
    .digest('hex')
    .slice(0, 32);

  return `reserva-canchas:migrations:${databaseHash}`;
}

async function acquireLock(connection, lockName) {
  const [rows] = await connection.execute(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [lockName, LOCK_TIMEOUT_SECONDS],
  );

  if (Number(rows[0]?.acquired) !== 1) {
    throw new Error(
      `Could not acquire the migration lock within ${LOCK_TIMEOUT_SECONDS} seconds`,
    );
  }
}

async function releaseLock(connection, lockName) {
  const [rows] = await connection.execute(
    'SELECT RELEASE_LOCK(?) AS released',
    [lockName],
  );

  if (Number(rows[0]?.released) !== 1) {
    console.warn('The migration lock was not held when release was attempted');
  }
}

function printMigrations(title, migrations) {
  console.log(title);

  if (migrations.length === 0) {
    console.log('  none');
    return;
  }

  for (const migration of migrations) {
    console.log(`  ${migration.name}`);
  }
}

async function runCommand(command, migrator) {
  if (command === 'up') {
    const migrations = await migrator.up();
    printMigrations('Applied migrations:', migrations);
    return;
  }

  if (command === 'down') {
    const migrations = await migrator.down({ step: 1 });
    printMigrations('Reverted migrations:', migrations);
    return;
  }

  const executed = await migrator.executed();
  const pending = await migrator.pending();
  printMigrations('Executed migrations:', executed);
  printMigrations('Pending migrations:', pending);
}

async function main() {
  const command = process.argv[2];

  if (!SUPPORTED_COMMANDS.has(command)) {
    throw new Error('Usage: migrate-cli.js <up|down|status>');
  }

  const config = loadDatabaseConfig({ forMigrations: true });

  if (command === 'down' && config.environment === 'production') {
    throw new Error('Migration down is disabled in production');
  }

  const connection = await createMigrationConnection(config);
  const lockName = migrationLockName(config.database);
  let lockAcquired = false;

  try {
    await acquireLock(connection, lockName);
    lockAcquired = true;

    const migrator = createMigrator(connection);
    await runCommand(command, migrator);
  } finally {
    try {
      if (lockAcquired) {
        await releaseLock(connection, lockName);
      }
    } finally {
      await connection.end();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
