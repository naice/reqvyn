import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/reqvyn.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: !watch,
  legalComments: 'linked',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
};
await build(options);
try {
  chmodSync('dist/reqvyn.cjs', 0o755);
} catch {
  /* not supported on this platform */
}
