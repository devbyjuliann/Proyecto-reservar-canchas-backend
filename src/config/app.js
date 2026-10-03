const ENVIRONMENTS = new Set(['development', 'test', 'production']);
const APP_ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);

function parsePort(value) {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseFrontendOrigin(environment) {
  const value = process.env.FRONTEND_ORIGIN
    ?? (environment === 'production' ? undefined : 'http://localhost:5173');
  if (value === undefined || value.trim() === '') {
    throw new Error('FRONTEND_ORIGIN is required in production');
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
      throw new Error();
    }
    if (environment === 'production' && url.protocol !== 'https:') {
      throw new Error('FRONTEND_ORIGIN must use HTTPS in production');
    }
    return url.origin;
  } catch (error) {
    if (error.message === 'FRONTEND_ORIGIN must use HTTPS in production') throw error;
    throw new Error('FRONTEND_ORIGIN must be an exact HTTP(S) origin');
  }
}

export function loadAppConfig() {
  const environment = process.env.NODE_ENV;
  if (environment === undefined) {
    throw new Error('NODE_ENV is required');
  }
  if (environment === '') {
    throw new Error('NODE_ENV cannot be empty');
  }
  if (!ENVIRONMENTS.has(environment)) {
    throw new Error(`Unsupported NODE_ENV: ${environment}`);
  }
  const appEnvironment = parseAppEnvironment(environment);

  const host = (process.env.HOST ?? '127.0.0.1').trim();
  if (host === '') {
    throw new Error('HOST cannot be blank');
  }

  return Object.freeze({
    environment,
    appEnvironment,
    host,
    port: parsePort(process.env.PORT),
    frontendOrigin: parseFrontendOrigin(environment),
    wompi: loadWompiConfig(appEnvironment),
  });
}

function parseAppEnvironment(nodeEnvironment) {
  const appEnvironment = process.env.APP_ENV?.trim()
    || (nodeEnvironment === 'production' ? 'production' : nodeEnvironment);
  if (!APP_ENVIRONMENTS.has(appEnvironment)) {
    throw new Error(`Unsupported APP_ENV: ${appEnvironment}`);
  }
  if (nodeEnvironment === 'production' && !['staging', 'production'].includes(appEnvironment)) {
    throw new Error('NODE_ENV=production requires APP_ENV=staging or APP_ENV=production');
  }
  if (nodeEnvironment === 'test' && appEnvironment !== 'test') {
    throw new Error('NODE_ENV=test requires APP_ENV=test');
  }
  return appEnvironment;
}

function loadWompiConfig(appEnvironment) {
  const names = ['WOMPI_ENVIRONMENT', 'WOMPI_PUBLIC_KEY', 'WOMPI_PRIVATE_KEY', 'WOMPI_INTEGRITY_SECRET', 'WOMPI_EVENTS_SECRET'];
  const values = Object.fromEntries(names.map((name) => [name, process.env[name]?.trim() || undefined]));
  const present = Object.values(values).some(Boolean);
  if (!present) return Object.freeze({ enabled: false });
  if (appEnvironment === 'production') throw new Error('Wompi production is not enabled');
  if (values.WOMPI_ENVIRONMENT !== 'sandbox' || Object.values(values).some((value) => !value)) {
    throw new Error('Wompi requires WOMPI_ENVIRONMENT=sandbox and all Wompi credentials');
  }
  if (!values.WOMPI_PUBLIC_KEY.startsWith('pub_test_') || !values.WOMPI_PRIVATE_KEY.startsWith('prv_test_')) {
    throw new Error('Wompi sandbox keys must use test prefixes');
  }
  return Object.freeze({ enabled: true, publicKey: values.WOMPI_PUBLIC_KEY, privateKey: values.WOMPI_PRIVATE_KEY,
    integritySecret: values.WOMPI_INTEGRITY_SECRET, eventsSecret: values.WOMPI_EVENTS_SECRET });
}
