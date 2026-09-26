import { describe } from 'node:test';

const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const configured = process.env.NODE_ENV === 'test'
  && required.every((name) => process.env[name])
  && process.env.DB_NAME.endsWith('_test');

// Runtime assertions require an explicitly provisioned disposable MySQL database.
describe('administrative MySQL integration', { skip: !configured }, () => {});
