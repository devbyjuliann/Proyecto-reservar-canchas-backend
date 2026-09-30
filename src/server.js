import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app/create-app.js';
import { loadAppConfig } from './config/app.js';
import { createMySqlPool } from './database/pool.js';
import {
  createBookingModule,
  createMySqlBookingAdapter,
} from './modules/booking/index.js';
import { createAuthModule, createMySqlAuthAdapter } from './modules/auth/index.js';
import { createMySqlUsersAdapter } from './modules/users/index.js';
import { createFacilitiesModule, createMySqlFacilitiesAdapter } from './modules/facilities/index.js';
import { createOwnerApplicationsModule, createMySqlOwnerApplicationsAdapter } from './modules/owner-applications/index.js';
import { createFacilityMembershipsModule, createMySqlFacilityMembershipsAdapter } from './modules/facility-memberships/index.js';
import { createPublicCatalogModule, createMySqlPublicCatalogAdapter } from './modules/public-catalog/index.js';
import { createCourtPricingModule, createMySqlCourtPricingAdapter } from './modules/court-pricing/index.js';
import { createOwnerDirectoryModule, createMySqlOwnerDirectoryAdapter } from './modules/owner-directory/index.js';
import { createSystemClock } from './shared/clock.js';

export async function startServer() {
  const config = loadAppConfig();
  const pool = createMySqlPool();
  const usersAdapter = createMySqlUsersAdapter({ pool });
  const catalogAdapter = createMySqlPublicCatalogAdapter({ pool });
  const bookingAdapter = createMySqlBookingAdapter({ pool, isPublicCourt: catalogAdapter.isPublicCourt });
  const clock = createSystemClock();
  const auth = createAuthModule({ adapter: createMySqlAuthAdapter({ pool }), clock });
  const booking = createBookingModule({
    adapter: bookingAdapter,
    clock,
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
  });

  const server = app.listen(config.port, config.host, () => {
    console.info(`Reserva Canchas listening on http://${config.host}:${config.port}`);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
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
