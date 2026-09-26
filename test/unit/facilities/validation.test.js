import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAdministrator,
  isValidIanaTimezone,
  validateCreateCourtInput,
  validateCreateFacilityInput,
  validateUpdateCourtInput,
} from '../../../src/modules/facilities/index.js';

test('IANA timezone validation accepts valid zones and rejects unknown zones', () => {
  assert.equal(isValidIanaTimezone('America/Bogota'), true);
  assert.equal(isValidIanaTimezone('Mars/Olympus_Mons'), false);
});

test('facility creation applies the MVP advance defaults', () => {
  assert.deepEqual(
    validateCreateFacilityInput({ name: '  Central  ', timeZone: 'America/Bogota' }),
    {
      name: 'Central',
      timeZone: 'America/Bogota',
      minimumAdvanceMinutes: 15,
      maximumAdvanceMinutes: 43_200,
    },
  );
});

test('facility creation rejects an inverted advance window', () => {
  assert.throws(
    () =>
      validateCreateFacilityInput({
        name: 'Central',
        timeZone: 'America/Bogota',
        minimumAdvanceMinutes: 60,
        maximumAdvanceMinutes: 30,
      }),
    { code: 'invalid_request' },
  );
});

test('court creation validates non-negative separation and positive interval', () => {
  assert.deepEqual(
    validateCreateCourtInput({
      name: ' Court 1 ',
      description: ' Indoor ',
      minimumSeparationMinutes: 0,
      startIntervalMinutes: 30,
      allowedDurationsMinutes: [60, 30],
    }),
    {
      name: 'Court 1',
      description: 'Indoor',
      minimumSeparationMinutes: 0,
      startIntervalMinutes: 30,
      allowedDurationsMinutes: [30, 60],
    },
  );
  assert.throws(
    () =>
      validateCreateCourtInput({
        name: 'Court 1',
        minimumSeparationMinutes: 0,
        startIntervalMinutes: 0,
        allowedDurationsMinutes: [30],
      }),
    { code: 'invalid_request' },
  );
});

test('court updates only accept descriptive fields', () => {
  assert.deepEqual(validateUpdateCourtInput({ description: '  New floor  ' }), {
    description: 'New floor',
  });
  assert.throws(() => validateUpdateCourtInput({ startIntervalMinutes: 15 }), {
    code: 'invalid_request',
  });
});

test('administrative methods require an administrator actor', () => {
  assert.doesNotThrow(() =>
    assertAdministrator({ id: '7', roles: ['USUARIO', 'ADMINISTRADOR'] }),
  );
  assert.throws(() => assertAdministrator(), { code: 'authentication_required' });
  assert.throws(() => assertAdministrator({ id: '7', roles: ['USUARIO'] }), {
    code: 'forbidden',
  });
});

test('facility creation requires advance limits together and rejects unknown fields', () => {
  assert.throws(
    () => validateCreateFacilityInput({
      name: 'Central',
      timeZone: 'America/Bogota',
      minimumAdvanceMinutes: 15,
    }),
    { code: 'invalid_request' },
  );
  assert.throws(
    () => validateCreateFacilityInput({
      name: 'Central',
      timeZone: 'America/Bogota',
      deactivatedAt: null,
    }),
    { code: 'invalid_request' },
  );
});
