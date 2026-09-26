import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Umzug } from 'umzug';

import { MySqlMigrationStorage } from './mysql-migration-storage.js';

const migrationsDirectory = fileURLToPath(
  new URL('./migrations/', import.meta.url),
);

export function createMigrator(connection) {
  const migrationGlob = join(migrationsDirectory, '*.js').replaceAll('\\', '/');

  return new Umzug({
    migrations: { glob: migrationGlob },
    context: connection,
    storage: new MySqlMigrationStorage(),
    logger: console,
  });
}
