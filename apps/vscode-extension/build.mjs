import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Webview bundle is built by @reqvyn/ui (Vite) and copied next to the extension.
const uiDist = join(here, '../../packages/ui/dist');
const webviewOut = join(here, 'dist/webview');
if (!existsSync(join(uiDist, 'webview.js'))) {
  console.error('packages/ui/dist/webview.js is missing – run `pnpm --filter @reqvyn/ui build` first.');
  process.exit(1);
}
rmSync(webviewOut, { recursive: true, force: true });
mkdirSync(webviewOut, { recursive: true });
cpSync(uiDist, webviewOut, { recursive: true });

// Marketplace README/CHANGELOG/LICENSE are derived from the repository root. Relative links only
// work on the repository host, so they are turned into plain text (the logo is shown by `icon`).
// Relative images (screenshots) point to the raw files on GitHub instead, so they still show up.
const root = join(here, '../..');
const rawBase = 'https://raw.githubusercontent.com/naice/reqvyn/main/';
const readme = readFileSync(join(root, 'README.md'), 'utf8')
  .replace(/<p align="center">\s*<img[^>]*>\s*<\/p>\s*/i, '')
  .replace(/!\[([^\]]*)\]\((?!https?:)([^)]+)\)/g, (_, alt, path) => `![${alt}](${rawBase}${path})`)
  .replace(/(?<!!)\[([^\]]+)\]\((?!https?:|#)[^)]+\)/g, '$1');
writeFileSync(join(here, 'README.md'), readme);
cpSync(join(root, 'CHANGELOG.md'), join(here, 'CHANGELOG.md'));
cpSync(join(root, 'LICENSE'), join(here, 'LICENSE'));

const options = {
  absWorkingDir: here,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  legalComments: 'linked',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
