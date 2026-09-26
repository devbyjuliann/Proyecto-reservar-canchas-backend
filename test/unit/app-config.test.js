import assert from 'node:assert/strict';
import test from 'node:test';

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
