# playground.actcore.dev

Live: **https://playground.actcore.dev**

A browser-native AI agent stack. Paste a wasm component URL, the tool loads and runs in your tab. No server, no Node, no install.

## What this is

A demonstration of [`@actcore/web-runtime`](https://github.com/actcore/web-runtime) — a browser host for [ACT](https://actcore.dev) components. Each tool is a wasm component packed with `act-build`, distributed via an OCI registry, and signed by its author. The playground:

1. Resolves a URL (`oci://`, `https://`, or a dropped `.wasm` file).
2. Pulls the bytes. Most OCI fetches go through [`oci-cors-proxy`](https://github.com/actcore/oci-cors-proxy) so the browser sees permissive CORS; registries that serve CORS themselves (e.g. [`actpkg.dev`](https://actpkg.dev)) are fetched directly.
3. Verifies the SHA-256 of the bytes against the OCI manifest digest.
4. Transpiles the component in-page via `@bytecodealliance/jco`.
5. Instantiates it (WebAssembly Component Model, wasip3-async, JSPI).
6. Exposes its `act:tools/tool-provider` so you can click "Run" and see the output.

In a follow-up iteration, a local [WebLLM](https://github.com/mlc-ai/web-llm) Llama-3.2 will call these tools via function-calling — the full agent loop, in your tab, with no remote API key.

## Run locally

This repo expects `actcore/web-runtime` checked out as a sibling directory (the
`@actcore/web-runtime` dependency is referenced via `file:../host-browser`).

```sh
git clone https://github.com/actcore/web-runtime ../host-browser
# host-browser fetches its WIT deps with wkg (https://github.com/bytecodealliance/wasm-pkg-tools)
cd ../host-browser && npm install && npm run sync-wit && npm run build
cd -                                            # back to playground
npm install
npm run dev                                     # http://localhost:5173
```

## Deploy

Pushed to `main` triggers `.github/workflows/pages.yml`, which:

1. Builds `@actcore/web-runtime` from the sibling repo (PAT required, see workflow).
2. Builds the playground with Vite.
3. Publishes to GitHub Pages.

Custom domain `playground.actcore.dev` set via `public/CNAME`.

## Browser support

Requires JSPI, which is on by default in Chrome/Edge 137+ and Firefox 153+ (desktop and Android). Safari has it in Tech Preview and is committed to shipping under Interop 2026.

## License

MIT OR Apache-2.0
