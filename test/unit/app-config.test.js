import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { loadAppConfig } from '../../src/config/app.js';
import { loadDatabaseConfig } from '../../src/config/database.js';

function withNodeEnv(value, operation) {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;

  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

function withEnvironment(values, operation) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return operation();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('app configuration requires NODE_ENV', () => {
  withNodeEnv(undefined, () => {
    assert.throws(() => loadAppConfig(), /NODE_ENV is required/);
  });
});

test('app configuration rejects an empty NODE_ENV', () => {
  withNodeEnv('', () => {
    assert.throws(() => loadAppConfig(), /NODE_ENV cannot be empty/);
  });
});

test('app configuration rejects an unknown NODE_ENV', () => {
  withNodeEnv('staging', () => {
    assert.throws(() => loadAppConfig(), /Unsupported NODE_ENV: staging/);
  });
});

test('production requires one exact HTTPS frontend origin', () => {
  withEnvironment({ NODE_ENV: 'production', FRONTEND_ORIGIN: undefined }, () => {
    assert.throws(() => loadAppConfig(), /FRONTEND_ORIGIN is required/);
  });
  for (const origin of ['http://app.example.test', 'https://app.example.test/', 'not-a-url']) {
    withEnvironment({ NODE_ENV: 'production', FRONTEND_ORIGIN: origin }, () => {
      assert.throws(() => loadAppConfig(), /FRONTEND_ORIGIN/);
    });
  }
  withEnvironment({
    NODE_ENV: 'production',
    FRONTEND_ORIGIN: 'https://app.example.test',
  }, () => {
    assert.equal(loadAppConfig().frontendOrigin, 'https://app.example.test');
  });
});

test('development and test use a local frontend origin by default', () => {
  for (const environment of ['development', 'test']) {
    withEnvironment({ NODE_ENV: environment, FRONTEND_ORIGIN: undefined }, () => {
      assert.equal(loadAppConfig().frontendOrigin, 'http://localhost:5173');
    });
  }
});

test('Railway production can use Wompi Sandbox without enabling Wompi production', () => {
  const credentials = {
    WOMPI_ENVIRONMENT: 'sandbox',
    WOMPI_PUBLIC_KEY: 'pub_test_public',
    WOMPI_PRIVATE_KEY: 'prv_test_private',
    WOMPI_INTEGRITY_SECRET: 'integrity_secret',
    WOMPI_EVENTS_SECRET: 'events_secret',
  };
  withEnvironment({
    NODE_ENV: 'production', APP_ENV: 'production', FRONTEND_ORIGIN: 'https://app.example.test', ...credentials,
  }, () => {
    const config = loadAppConfig();
    assert.equal(config.environment, 'production');
    assert.equal(config.appEnvironment, 'production');
    assert.equal(config.wompi.enabled, true);
    assert.equal(config.wompi.environment, 'sandbox');
  });
  for (const name of Object.keys(credentials)) {
    withEnvironment({ NODE_ENV: 'test', ...credentials, [name]: undefined }, () => {
      assert.throws(() => loadAppConfig(), /Wompi requires WOMPI_ENVIRONMENT=sandbox or production and all Wompi credentials/);
    });
  }
});

test('removed staging APP_ENV is rejected and test runtime cannot use production APP_ENV', () => {
  withEnvironment({ NODE_ENV: 'production', APP_ENV: 'staging' }, () => {
    assert.throws(() => loadAppConfig(), /Unsupported APP_ENV: staging/);
  });
  withEnvironment({ NODE_ENV: 'test', APP_ENV: 'staging' }, () => {
    assert.throws(() => loadAppConfig(), /Unsupported APP_ENV: staging/);
  });
  withEnvironment({ NODE_ENV: 'test', APP_ENV: 'production' }, () => {
    assert.throws(() => loadAppConfig(), /NODE_ENV=test requires APP_ENV=test/);
  });
});

test('Railway production plus Wompi Sandbox does not register any /api/v1/test route', async () => {
  const app = withEnvironment({ NODE_ENV: 'production', APP_ENV: 'production',
    FRONTEND_ORIGIN: 'https://app.example.test', WOMPI_ENVIRONMENT: 'sandbox',
    WOMPI_PUBLIC_KEY: 'pub_test_public', WOMPI_PRIVATE_KEY: 'prv_test_private',
    WOMPI_INTEGRITY_SECRET: 'test_integrity_placeholder', WOMPI_EVENTS_SECRET: 'test_events_placeholder',
  }, () => {
    const config = loadAppConfig();
    assert.equal(config.wompi.enabled, true);
    return createApp({ environment: config.environment, frontendOrigin: config.frontendOrigin,
      booking: { approveTestPayment: async () => ({ approved: true }) },
      findActiveUserById: async () => null, logger: { error() {} },
      wompi: { config: config.wompi, provider: {},
        redirectUrl: `${config.frontendOrigin}/reservas/pago` } });
  });
  await request(app).post('/api/v1/test/bookings/901/payments/approve')
    .set('Origin', 'https://app.example.test')
    .send({ amountMinor: 1, providerReference: 'test' }).expect(404);
  await request(app).get('/api/v1/test/missing').expect(404);
});

test('Wompi production credentials cannot activate the future provider yet', () => {
  const values = { NODE_ENV: 'production', APP_ENV: 'production', FRONTEND_ORIGIN: 'https://app.example.test',
    WOMPI_ENVIRONMENT: 'production', WOMPI_PUBLIC_KEY: 'pub_prod_public', WOMPI_PRIVATE_KEY: 'prv_prod_private',
    WOMPI_INTEGRITY_SECRET: 'prod_integrity_placeholder', WOMPI_EVENTS_SECRET: 'prod_events_placeholder' };
  withEnvironment(values, () => assert.throws(() => loadAppConfig(), /Wompi production is not enabled/));
  withEnvironment({ ...values, WOMPI_PRIVATE_KEY: 'prv_test_private' }, () => {
    assert.throws(() => loadAppConfig(), /Wompi production keys must use matching prefixes/);
  });
  withEnvironment({ ...values, WOMPI_EVENTS_SECRET: 'test_events_secret' }, () => {
    assert.throws(() => loadAppConfig(), /Wompi production secrets must use production prefixes/);
  });
  withEnvironment({ ...values, WOMPI_REFUND_TEST_SCENARIO: 'approved' }, () => {
    assert.throws(() => loadAppConfig(), /Unsupported Wompi refund Sandbox scenario/);
  });
});

test('production requires every database connection variable before starting', () => {
  const complete = {
    NODE_ENV: 'production',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_USER: 'example_user',
    DB_PASSWORD: 'example_only',
    DB_NAME: 'example_database',
  };
  for (const name of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    withEnvironment({ ...complete, [name]: undefined }, () => {
      assert.throws(() => loadDatabaseConfig(), new RegExp(name));
    });
  }
});
