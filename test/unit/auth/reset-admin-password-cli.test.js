import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { it } from 'node:test';

import { resetAdministratorPasswordCli } from '../../../src/modules/auth/reset-admin-password-cli.js';

it('reads email and password from stdin without writing the password', async () => {
  let received;
  let output = '';
  const input = Readable.from([' ADMIN@EXAMPLE.COM \nnew password value\n']);
  const sink = new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } });
  await resetAdministratorPasswordCli({
    input,
    output: sink,
    auth: {
      async resetAdministratorPassword(values) {
        received = values;
        return true;
      },
    },
  });
  assert.deepEqual(received, { email: ' ADMIN@EXAMPLE.COM ', password: 'new password value' });
  assert.equal(output, 'Administrator password reset\n');
  assert.equal(output.includes('new password value'), false);
});

it('aborts when the account is not an administrator', async () => {
  await assert.rejects(resetAdministratorPasswordCli({
    input: Readable.from(['user@example.com\nnew password value\n']),
    output: new Writable({ write(chunk, encoding, callback) { callback(); } }),
    auth: { async resetAdministratorPassword() { return false; } },
  }), { message: 'Administrator account was not found' });
});
