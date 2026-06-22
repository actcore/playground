import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// @actcore/host imports jco's in-browser transpiler from the vendored,
// componentized bindgen at this subpath. jco-transpile does not list `./vendor/*`
// in its package `exports`, so Vite/Rollup's exports-respecting resolver can't
// reach it — alias it to the concrete file. (jco's documented browser entry,
// @bytecodealliance/jco/component, is broken in 1.24: its obj/ glue isn't
// published.)
const jcoBindgen = fileURLToPath(
  new URL(
    './node_modules/@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js',
    import.meta.url,
  ),
);

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
  resolve: {
    alias: {
      '@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.js':
        jcoBindgen,
    },
  },
  optimizeDeps: {
    // Bypass Vite's pre-bundling for @actcore/host so we can iterate on its
    // source without `npm install`-rebuilding the dep cache.
    exclude: ['@actcore/host'],
  },
});