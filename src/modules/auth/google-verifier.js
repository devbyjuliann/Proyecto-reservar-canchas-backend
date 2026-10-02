import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

export function createGoogleVerifier({ clientId, environment, testSecret } = {}) {
  if (!clientId) return null;
  if (environment === 'test' && testSecret) {
    // A test-only signed fixture seam; never enabled in development or production.
    return async (credential) => {
      const [payload, signature, extra] = String(credential).split('.');
      if (!payload || !signature || extra !== undefined) throw new Error('Invalid Google credential');
      const expected = createHmac('sha256', testSecret).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('Invalid Google credential');
      }
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (claims.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
        || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
        throw new Error('Invalid Google credential');
      }
      return claims;
    };
  }
  const client = new OAuth2Client(clientId);
  return async (credential) => {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const claims = ticket.getPayload();
    if (claims?.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
      || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('Invalid Google credential');
    }
    return claims;
  };
}
