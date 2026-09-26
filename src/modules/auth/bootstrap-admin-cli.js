import { once } from 'node:events';
import { stdin, stdout } from 'node:process';
import { createInterface, emitKeypressEvents } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSystemClock } from '../../shared/clock.js';
import { createMySqlPool } from '../../database/pool.js';
import { createAuthModule } from './auth.js';
import { createMySqlAuthAdapter } from './mysql-adapter.js';

export async function bootstrapAdministratorCli({
  input = stdin,
  output = stdout,
  pool = createMySqlPool(),
} = {}) {
  if (process.argv.length > 2) {
    throw new Error('This command does not accept arguments; passwords must be read from stdin');
  }

  try {
    const values = input.isTTY
      ? await readInteractive(input, output)
      : await readPiped(input);
    const auth = createAuthModule({
      adapter: createMySqlAuthAdapter({ pool }),
      clock: createSystemClock(),
    });
    const user = await auth.bootstrapAdministrator(values);
    output.write(`Administrator created: ${user.email}\n`);
    return user;
  } finally {
    await pool.end();
  }
}

async function readInteractive(input, output) {
  const prompt = createInterface({ input, output });
  const email = await question(prompt, 'Email: ');
  const name = await question(prompt, 'Name: ');
  prompt.close();
  const password = await readHiddenPassword(input, output);
  return { email, name, password };
}

function question(interface_, text) {
  return new Promise((resolve) => interface_.question(text, resolve));
}

async function readHiddenPassword(input, output) {
  output.write('Password: ');
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let password = '';
  try {
    while (true) {
      const [text, key] = await once(input, 'keypress');
      if (key?.ctrl && key.name === 'c') throw new Error('Administrator bootstrap cancelled');
      if (key?.name === 'return' || key?.name === 'enter') break;
      if (key?.name === 'backspace') {
        password = password.slice(0, -1);
      } else if (!key?.ctrl && !key?.meta && typeof text === 'string') {
        password += text;
      }
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
  if (lines.length !== 3) {
    throw new Error('stdin must contain exactly three lines: email, name, and password');
  }
  return { email: lines[0], name: lines[1], password: lines[2] };
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  bootstrapAdministratorCli().catch((error) => {
    console.error(error?.message ?? 'Administrator bootstrap failed');
    process.exitCode = 1;
  });
}
