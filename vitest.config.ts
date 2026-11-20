import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Extension unit tests run without VS Code; see apps/vscode-extension/test/unit/vscode.mock.ts.
    alias: { vscode: fileURLToPath(new URL('./apps/vscode-extension/test/unit/vscode.mock.ts', import.meta.url)) },
  },
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.tsx',
      'apps/**/test/unit/**/*.test.ts',
      'examples/**/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 20000,
    pool: 'forks',
  },
});
