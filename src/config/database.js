const ENVIRONMENTS = new Set(['development', 'test', 'production']);

function requiredVariable(name) {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requiredTrimmedVariable(name) {
  const value = requiredVariable(name).trim();

  if (value === '') {
    throw new Error(`Environment variable cannot be blank: ${name}`);
  }

  return value;
}

function parsePort(value) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be an integer between 1 and 65535');
  }

  return port;
}

export function loadDatabaseConfig({ forMigrations = false } = {}) {
  const environment = process.env.NODE_ENV ?? 'development';

  if (!ENVIRONMENTS.has(environment)) {
    throw new Error(`Unsupported NODE_ENV: ${environment}`);
  }

  const database = requiredTrimmedVariable('DB_NAME');

  if (environment === 'test' && !database.endsWith('_test')) {
    throw new Error('Test migrations require DB_NAME to end with "_test"');
  }

  const useMigrationCredentials = forMigrations && environment === 'production';
  const userVariable = useMigrationCredentials ? 'MIGRATION_DB_USER' : 'DB_USER';
  const passwordVariable = useMigrationCredentials
    ? 'MIGRATION_DB_PASSWORD'
    : 'DB_PASSWORD';

  return {
    environment,
    host: requiredTrimmedVariable('DB_HOST'),
    port: parsePort(requiredVariable('DB_PORT')),
    user: requiredTrimmedVariable(userVariable),
    password: requiredVariable(passwordVariable),
    database,
  };
}
