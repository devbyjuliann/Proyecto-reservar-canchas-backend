import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app/create-app.js';
import { loadAppConfig } from './config/app.js';
import { createMySqlPool } from './database/pool.js';
import {
  createBookingModule,
  createBookingEmailNotifier,
  createMySqlBookingAdapter,
} from './modules/booking/index.js';
import { createAuthModule, createGoogleVerifier, createMySqlAuthAdapter, createPasswordResetMailer } from './modules/auth/index.js';
import { createMySqlUsersAdapter } from './modules/users/index.js';
import { createFacilitiesModule, createMySqlFacilitiesAdapter } from './modules/facilities/index.js';
import { createOwnerApplicationsModule, createMySqlOwnerApplicationsAdapter } from './modules/owner-applications/index.js';
import { createFacilityMembershipsModule, createMySqlFacilityMembershipsAdapter } from './modules/facility-memberships/index.js';
import { createPublicCatalogModule, createMySqlPublicCatalogAdapter } from './modules/public-catalog/index.js';
import { createCourtPricingModule, createMySqlCourtPricingAdapter } from './modules/court-pricing/index.js';
import { createOwnerDirectoryModule, createMySqlOwnerDirectoryAdapter } from './modules/owner-directory/index.js';
import { createSystemClock } from './shared/clock.js';
import { createEmailTransport } from './shared/email-transport.js';
import { createWompiProvider } from './modules/payments/index.js';
import { createRefundEngine } from './modules/payments/refunds.js';

export async function startServer() {
  const config = loadAppConfig();
  const sendEmail = createEmailTransport({ environment: config.environment });
  const sendPasswordResetEmail = createPasswordResetMailer({ sendEmail });
  const pool = createMySqlPool();
  const usersAdapter = createMySqlUsersAdapter({ pool });
  const catalogAdapter = createMySqlPublicCatalogAdapter({ pool });
  const bookingAdapter = createMySqlBookingAdapter({ pool, isPublicCourt: catalogAdapter.isPublicCourt });
  const clock = createSystemClock();
  const wompiProvider = config.wompi.enabled ? createWompiProvider({ config: config.wompi }) : null;
  const bookingNotifications = createBookingEmailNotifier({ sendEmail, frontendOrigin: config.frontendOrigin });
  const refunds = wompiProvider ? createRefundEngine({ pool, provider: wompiProvider,
    notifications: bookingNotifications }) : null;
  const auth = createAuthModule({
    adapter: createMySqlAuthAdapter({ pool }), clock, frontendOrigin: config.frontendOrigin,
    sendPasswordResetEmail,
    verifyGoogleCredential: createGoogleVerifier({ clientId: process.env.GOOGLE_CLIENT_ID,
      environment: config.environment, testSecret: process.env.AUTH_TEST_GOOGLE_SECRET }),
  });
  const booking = createBookingModule({
    adapter: bookingAdapter,
    clock,
    notifications: bookingNotifications, refunds,
  });
  const facilities = createFacilitiesModule({ adapter: createMySqlFacilitiesAdapter({ pool }), clock });
  const ownerApplications = createOwnerApplicationsModule({
    adapter: createMySqlOwnerApplicationsAdapter({ pool }), clock,
  });
  const memberships = createFacilityMembershipsModule({
    adapter: createMySqlFacilityMembershipsAdapter({ pool }), clock,
  });
  const catalog = createPublicCatalogModule({
    adapter: catalogAdapter, clock,
  });
  const pricing = createCourtPricingModule({
    adapter: createMySqlCourtPricingAdapter({ pool }), memberships,
  });
  const ownerDirectory = createOwnerDirectoryModule({ adapter: createMySqlOwnerDirectoryAdapter({ pool }), clock });
  const app = createApp({
    booking,
    facilities,
    auth,
    ownerApplications,
    memberships,
    catalog,
    pricing,
    ownerDirectory,
    environment: config.environment,
    frontendOrigin: config.frontendOrigin,
    findActiveUserById: (userId) => usersAdapter.findById(userId),
    wompi: config.wompi.enabled ? {
      config: config.wompi,
      provider: wompiProvider, refunds,
      redirectUrl: `${config.frontendOrigin}/reservas/pago`,
    } : undefined,
  });

  const server = app.listen(config.port, config.host, () => {
    console.info(`Reserva Canchas listening on http://${config.host}:${config.port}`);
  });
  const refundPoller = refunds && setInterval(async () => {
    try { await refunds.processPending(); }
    catch { console.error('Refund poll failed'); }
  }, 60_000);
  refundPoller?.unref();
  if (refunds) refunds.processPending().catch(() => console.error('Refund startup poll failed'));

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (refundPoller) clearInterval(refundPoller);
    server.close(async () => {
      await pool.end();
      process.exitCode = 0;
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { app, server, pool };
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
