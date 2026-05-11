import { defineConfig } from 'vite';

export default defineConfig({
  // gh-pages serves under https://playground.actcore.dev/ — root path.
  // If we ever deploy under a sub-path, change to `'/playground/'` etc.
  base: '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    // Bypass Vite's pre-bundling for @actcore/host so we can iterate on its
    // source without `npm install`-rebuilding the dep cache.
    exclude: ['@actcore/host'],
  },
});