import { once } from 'node:events';
import { stdin, stdout } from 'node:process';
import { createInterface, emitKeypressEvents } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSystemClock } from '../../shared/clock.js';
import { createMySqlPool } from '../../database/pool.js';
import { createAuthModule } from './auth.js';
import { createMySqlAuthAdapter } from './mysql-adapter.js';

export async function resetAdministratorPasswordCli({
  input = stdin,
  output = stdout,
  auth,
  pool,
} = {}) {
  if (process.argv.length > 2) {
    throw new Error('This command does not accept arguments; passwords must be read from stdin');
  }

  const ownedPool = pool ?? (auth ? null : createMySqlPool());
  try {
    const values = input.isTTY
      ? await readInteractive(input, output)
      : await readPiped(input);
    const module = auth ?? createAuthModule({
      adapter: createMySqlAuthAdapter({ pool: ownedPool }),
      clock: createSystemClock(),
    });
    if (!await module.resetAdministratorPassword(values)) {
      throw new Error('Administrator account was not found');
    }
    output.write('Administrator password reset\n');
  } finally {
    await ownedPool?.end();
  }
}

async function readInteractive(input, output) {
  const prompt = createInterface({ input, output });
  const email = await question(prompt, 'Email: ');
  prompt.close();
  const password = await readHiddenPassword(input, output);
  return { email, password };
}

function question(interface_, text) {
  return new Promise((resolve) => interface_.question(text, resolve));
}

async function readHiddenPassword(input, output) {
  output.write('New password: ');
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let password = '';
  try {
    while (true) {
      const [text, key] = await once(input, 'keypress');
      if (key?.ctrl && key.name === 'c') throw new Error('Administrator password reset cancelled');
      if (key?.name === 'return' || key?.name === 'enter') break;
      if (key?.name === 'backspace') password = password.slice(0, -1);
      else if (!key?.ctrl && !key?.meta && typeof text === 'string') password += text;
    }
  } finally {
    input.setRawMode(false);
    input.pause();
    output.write('\n');
  }
  return password;
}

async function readPiped(input) {
  input.setEncoding('utf8');
  let content = '';
  for await (const chunk of input) content += chunk;
  const lines = content.replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 2) {
    throw new Error('stdin must contain exactly two lines: email and new password');
  }
  return { email: lines[0], password: lines[1] };
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  resetAdministratorPasswordCli().catch((error) => {
    console.error(error?.message ?? 'Administrator password reset failed');
    process.exitCode = 1;
  });
}
