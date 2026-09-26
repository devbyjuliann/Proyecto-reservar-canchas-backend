import { Temporal } from '@js-temporal/polyfill';

import { toInstantString } from './time.js';

export function createSystemClock() {
  return Object.freeze({
    now: () => toInstantString(Temporal.Now.instant().toString()),
  });
}
