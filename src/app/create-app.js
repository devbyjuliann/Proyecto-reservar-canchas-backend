import express from 'express';

import { createAuthRouter } from '../modules/auth/index.js';
import { createBookingRouter } from '../modules/booking/http.js';
import { createAdminRouter } from '../modules/admin/index.js';
import { createOwnerApplicationsRouter } from '../modules/owner-applications/index.js';
import { createFacilityMembershipsRouter } from '../modules/facility-memberships/index.js';
import { createPublicCatalogRouter } from '../modules/public-catalog/index.js';
import { createCourtPricingRouter } from '../modules/court-pricing/index.js';
import { createOwnerOperationsRouter } from '../modules/owner/http.js';
import { createErrorHandler, notFoundHandler } from './error-handler.js';
import { createHttpSecurity } from './http-security.js';
import { createRequestContext } from './request-context.js';

export function createApp({
  booking,
  facilities,
  auth,
  ownerApplications,
  memberships,
  catalog,
  pricing,
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
  if (ownerApplications) app.use(createOwnerApplicationsRouter({ ownerApplications, requireIdentity }));
  if (memberships) app.use(createFacilityMembershipsRouter({ memberships, requireIdentity }));
  if (catalog) app.use(createPublicCatalogRouter({ catalog, facilities, requireIdentity }));
  if (pricing) app.use(createCourtPricingRouter({ pricing, requireIdentity }));
  if (memberships && facilities) app.use(createOwnerOperationsRouter({
    memberships, facilities, booking, requireIdentity,
  }));
  app.use(createBookingRouter({ booking, requireIdentity, catalog }));
  if (facilities) app.use(createAdminRouter({ facilities, booking, requireIdentity }));
  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger }));
  return app;
}
