const PRODUCTION_COOKIE = '__Host-reserva_session';
const LOCAL_COOKIE = 'reserva_session';

export function sessionCookieName(environment) {
  return environment === 'production' ? PRODUCTION_COOKIE : LOCAL_COOKIE;
}

export function sessionCookieOptions(environment, expiresAt) {
  const options = {
    httpOnly: true,
    secure: environment === 'production',
    sameSite: 'lax',
    path: '/',
  };
  if (expiresAt !== undefined) options.expires = new Date(expiresAt);
  return options;
}

export function readSessionCookie(request, environment) {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  const name = sessionCookieName(environment);
  const values = header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) return [];
    return [part.slice(separator + 1).trim()];
  });
  return values.length === 1 ? values[0] : undefined;
}
