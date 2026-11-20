import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Production: a single ES module bundle `dist/webview.js` + `dist/webview.css` (+ codicon font next to it).
 * No code splitting, no modulepreload polyfill, no inline scripts, no external resources (strict webview CSP).
 *
 * Dev preview (`pnpm --filter @reqvyn/ui dev:preview`): serves `dev/index.html` with a mock host.
 */
export default defineConfig(({ command }) => ({
  root,
  base: './',
  publicDir: false,
  plugins: [react()],
  server: { open: command === 'serve' ? '/dev/index.html' : false },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        format: 'es',
        inlineDynamicImports: true,
        entryFileNames: 'webview.js',
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? info.name ?? '';
          if (name.endsWith('.css')) return 'webview.css';
          return '[name][extname]';
        },
      },
    },
  },
}));
