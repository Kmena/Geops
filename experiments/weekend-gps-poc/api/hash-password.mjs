import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
reader.question('POC admin password: ', (password) => {
  reader.close();
  if (password.length < 16) {
    process.stderr.write('Minimum 16 characters\n');
    process.exitCode = 1;
    return;
  }
  const salt = randomBytes(16);
  process.stdout.write(
    salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex') + '\n',
  );
});
