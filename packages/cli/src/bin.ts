import { main } from './main.js';

const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  process.stderr.write('\nCancelling… (press Ctrl+C again to force quit)\n');
  controller.abort();
});

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

main(
  process.argv.slice(2),
  {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    cwd: process.cwd(),
    env: process.env,
    color,
    signal: controller.signal,
  },
  { input: process.stdin, output: (line) => void process.stdout.write(`${line}\n`) },
).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
