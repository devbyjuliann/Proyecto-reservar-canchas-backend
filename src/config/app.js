const ENVIRONMENTS = new Set(['development', 'test', 'production']);

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

  const host = (process.env.HOST ?? '127.0.0.1').trim();
  if (host === '') {
    throw new Error('HOST cannot be blank');
  }

  return Object.freeze({
    environment,
    host,
    port: parsePort(process.env.PORT),
    frontendOrigin: parseFrontendOrigin(environment),
  });
}
