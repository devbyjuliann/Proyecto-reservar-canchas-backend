const ENVIRONMENTS = new Set(['development', 'test', 'production']);
const APP_ENVIRONMENTS = new Set(['development', 'test', 'production']);

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
    wompi: loadWompiConfig(),
  });
}

function parseAppEnvironment(nodeEnvironment) {
  const appEnvironment = process.env.APP_ENV?.trim()
    || (nodeEnvironment === 'production' ? 'production' : nodeEnvironment);
  if (!APP_ENVIRONMENTS.has(appEnvironment)) {
    throw new Error(`Unsupported APP_ENV: ${appEnvironment}`);
  }
  if (nodeEnvironment === 'production' && appEnvironment !== 'production') {
    throw new Error('NODE_ENV=production requires APP_ENV=production');
  }
  if (nodeEnvironment === 'test' && appEnvironment !== 'test') {
    throw new Error('NODE_ENV=test requires APP_ENV=test');
  }
  return appEnvironment;
}

function loadWompiConfig() {
  const names = ['WOMPI_ENVIRONMENT', 'WOMPI_PUBLIC_KEY', 'WOMPI_PRIVATE_KEY', 'WOMPI_INTEGRITY_SECRET', 'WOMPI_EVENTS_SECRET'];
  const values = Object.fromEntries(names.map((name) => [name, process.env[name]?.trim() || undefined]));
  const present = Object.values(values).some(Boolean);
  if (!present) return Object.freeze({ enabled: false });
  if (!['sandbox', 'production'].includes(values.WOMPI_ENVIRONMENT)
    || Object.values(values).some((value) => !value)) {
    throw new Error('Wompi requires WOMPI_ENVIRONMENT=sandbox or production and all Wompi credentials');
  }
  const sandbox = values.WOMPI_ENVIRONMENT === 'sandbox';
  const prefixes = sandbox ? ['pub_test_', 'prv_test_']
    : ['pub_prod_', 'prv_prod_'];
  if (!values.WOMPI_PUBLIC_KEY.startsWith(prefixes[0]) || !values.WOMPI_PRIVATE_KEY.startsWith(prefixes[1])) {
    throw new Error(`Wompi ${values.WOMPI_ENVIRONMENT} keys must use matching prefixes`);
  }
  if (!sandbox && (!values.WOMPI_INTEGRITY_SECRET.startsWith('prod_integrity_')
    || !values.WOMPI_EVENTS_SECRET.startsWith('prod_events_'))) {
    throw new Error('Wompi production secrets must use production prefixes');
  }
  const refundScenario = process.env.WOMPI_REFUND_TEST_SCENARIO?.trim() || null;
  if (refundScenario && (!sandbox || !['approved', 'declined', 'error', 'cancelled'].includes(refundScenario))) {
    throw new Error('Unsupported Wompi refund Sandbox scenario');
  }
  // Provider production remains disabled until refunds and reconciliation are validated.
  if (!sandbox) throw new Error('Wompi production is not enabled');
  return Object.freeze({ enabled: true, publicKey: values.WOMPI_PUBLIC_KEY, privateKey: values.WOMPI_PRIVATE_KEY,
    integritySecret: values.WOMPI_INTEGRITY_SECRET, eventsSecret: values.WOMPI_EVENTS_SECRET,
    merchantId: process.env.WOMPI_MERCHANT_ID?.trim() || null, refundScenario,
    environment: values.WOMPI_ENVIRONMENT });
}
