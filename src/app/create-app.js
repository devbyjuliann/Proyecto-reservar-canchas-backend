import express from 'express';

import { createAuthRouter } from '../modules/auth/index.js';
import { createBookingRouter } from '../modules/booking/http.js';
import { createAdminRouter } from '../modules/admin/index.js';
import { createErrorHandler, notFoundHandler } from './error-handler.js';
import { createHttpSecurity } from './http-security.js';
import { createRequestContext } from './request-context.js';

export function createApp({
  booking,
  facilities,
  auth,
  findActiveUserById,
  environment,
  frontendOrigin = 'http://localhost:5173',
  logger = console,
}) {
  const app = express();
  app.disable('x-powered-by');
  if (environment === 'production') app.set('trust proxy', 'loopback');
  app.use(createHttpSecurity({ environment, frontendOrigin }));
  app.use(express.json({ limit: '32kb', strict: true, type: 'application/json' }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  const requireIdentity = createRequestContext({
    environment,
    findActiveUserById,
    resolveSession: auth?.resolveSession,
  });
  if (auth) app.use(createAuthRouter({ auth, environment, requireIdentity }));
  app.use(createBookingRouter({ booking, requireIdentity }));
  if (facilities) app.use(createAdminRouter({ facilities, booking, requireIdentity }));
  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger }));
  return app;
}
