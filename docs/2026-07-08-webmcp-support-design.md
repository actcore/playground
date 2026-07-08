# WebMCP support — design

- **Date:** 2026-07-08
- **Status:** Draft — awaiting review
- **Repos touched:** `host-browser` (`@actcore/host`) + `playground`
- **Author:** brainstormed with Claude

## Summary

Expose a loaded ACT component's tools on the browser's native
[WebMCP](https://webmachinelearning.github.io/webmcp/) surface
(`document.modelContext`) so a WebMCP-capable browser agent can discover and
call them. The reusable bridge lives in `@actcore/host` as an opt-in, headless
export; the playground calls it and renders a status line.

This makes "an ACT component is instantly callable by a browser agent" a
first-class feature of the ACT browser runtime, on the browser-wedge +
supply-chain-hardening narrative.

## Goal

- After a component loads in the playground, each ACT tool it provides is
  registered on `document.modelContext` and callable by a WebMCP agent.
- The bridge is reusable by any `@actcore/host` embedder, not just the
  playground.
- Zero new *runtime polyfill* dependency; feature-gated exactly like the
  existing JSPI gate.

## Non-goals (YAGNI)

- **No polyfill.** Native `document.modelContext` only (Chrome 149 origin
  trial / `chrome://flags/#enable-webmcp-testing`). Where absent, we show a
  notice — we do not ship `@mcp-b/global` or a home-grown shim.
- **No in-page consumer UI.** Status line only; no `getTools()`/`executeTool()`
  demo panel, no external-agent bridge wiring in-app.
- **No consuming** WebMCP tools from other tabs into the local WebLLM (that is
  the opposite direction; out of scope).
- **No image/binary content mapping.** Tool output is rendered text-first;
  non-text parts are summarized as `(mime, N bytes)`.
- **No refactor** of the existing `main.ts` / `chat.ts` tool-event→text
  duplication in this change.

## Decisions (resolved during brainstorming)

1. **Direction:** expose loaded tools *outward*.
2. **Provider:** native-only, feature-gated. No polyfill dependency.
3. **UI:** status-line only.
4. **Location:** split — headless bridge in `@actcore/host`, UI in playground.
5. **CBOR ownership (recommended, flag for review):** `@actcore/host` gains a
   small `cbor2` dependency so the bridge fully owns dcbor encode/decode. This
   keeps the public API clean (`exposeToWebmcp(provider, tools, options?)` — no
   codec injection) and matches "first-class runtime feature". Alternative
   considered: inject `encodeCbor`/`decodeCbor` callbacks to keep the host
   CBOR-free — rejected as leaking an implementation seam into a first-class API.
6. **Annotations default (flag for review):** map `readOnlyHint` from ACT
   `std:read-only` metadata, and set `untrustedContentHint: true` as a
   conservative default — tool output flows into agent context and a loaded
   component may fetch arbitrary web content (e.g. `http-client`); marking it
   untrusted is on-brand for ACT's hardening posture and cheap to reverse.

## Background: current API facts (verified 2026-07)

- Global is **`document.modelContext`** (canonical). `navigator.modelContext`
  is a legacy alias; `provideContext()` was removed 2026-03-05.
- Registration: `registerTool(tool, options?) => Promise<void>`. Unregistration
  is via **`AbortSignal`** (`options.signal`), not `unregisterTool()`.
- Descriptor: `{ name, description, execute }` required; `title`, `inputSchema`
  (plain **JSON Schema object**), `annotations` optional.
  - `name`: non-empty, ≤128 chars, ASCII `[A-Za-z0-9_.-]`; duplicate rejects
    with `InvalidStateError`.
  - `execute(input)`: receives a parsed args object; should return the MCP
    form `{ content: [{ type: 'text', text }], isError? }` (portable across
    native + tooling).
  - `annotations`: `{ readOnlyHint?: boolean, untrustedContentHint?: boolean }`.
- No browser ships it by default; Chrome 149 behind origin trial / flag.

This maps almost 1:1 onto ACT: `ToolDefinition.parametersSchema` is *already* a
JSON Schema string, `resolveLocalizedString` already resolves the description,
and the host already drains tool-events to content.

## Architecture

```
@actcore/host (headless bridge)          playground (UI)
─────────────────────────────            ─────────────────────────────
isWebmcpAvailable()                      startup gate → log() line
exposeToWebmcp(provider, tools, opts)  ← loadFromBytes() calls it
  → { count, available, dispose() }        → updates #webmcp-status
                                            → disposes prior on reload
```

### `@actcore/host` additions

New module `src/webmcp.ts`, re-exported from `src/index.ts`.

**Exports:**

```ts
/** True when the browser exposes a native WebMCP surface. */
export function isWebmcpAvailable(): boolean;

export interface ExposeWebmcpOptions {
  /** Current session id, read per invocation; when set, forwarded as
   *  `std:session-id` metadata on every callTool (mirrors playground runTool). */
  getSessionId?: () => string | null | undefined;
  /** WebMCP `exposedTo` origin allowlist. Omit = default visibility. */
  exposedTo?: string[];
}

export interface WebmcpExposure {
  /** Number of tools successfully registered (0 when unavailable). */
  count: number;
  /** False when no native WebMCP surface was present. */
  available: boolean;
  /** Abort the registration AbortController → unregisters all tools. Idempotent. */
  dispose(): void;
}

export function exposeToWebmcp(
  provider: ToolProvider,
  tools: ToolDefinition[],
  options?: ExposeWebmcpOptions,
): Promise<WebmcpExposure>;   // async: awaits each registerTool so `count`
                             // reflects confirmed registrations

```

**`getModelContext()` (internal):** returns `document.modelContext ??
navigator.modelContext ?? null`, guarded for non-window contexts.
`isWebmcpAvailable()` = `getModelContext() !== null`.

**Types:** `src/webmcp.ts` declares a minimal local `ModelContext` /
`ModelContextTool` interface (host `tsconfig` already has `lib: ["DOM"]`). A
tiny ambient augmentation adds `modelContext?: ModelContext` to `Document` and
`Navigator`. No dependency on `@mcp-b/webmcp-types`.

### `ToolDefinition` → WebMCP descriptor mapping (pure, testable)

`toDescriptor(provider, def, options)` builds one descriptor:

| WebMCP field  | Source |
|---------------|--------|
| `name`        | `sanitizeName(def.name)` — strip to `[A-Za-z0-9_.-]`, truncate 128 |
| `description` | `resolveLocalizedString(def.description)` |
| `inputSchema` | `JSON.parse(def.parametersSchema)`; fallback `{type:'object',properties:{}}` on empty/parse-fail |
| `annotations` | `{ readOnlyHint: <std:read-only from def.metadata>, untrustedContentHint: true }` |
| `execute`     | bridge → `provider.callTool` (below) |

`std:read-only` is read by scanning `def.metadata` (`Array<[string, Cbor]>`)
for the key and `cbor2.decode`-ing its value to a boolean; absent/undecodable →
omit `readOnlyHint`.

### `execute` bridge

```
execute(input):
  argBytes = cbor2.encode(input ?? {}, { dcbor: true })
  meta = getSessionId?.() ? [['std:session-id', encode(sessionId)]] : []
  result = await provider.callTool(def.name, argBytes, meta)
  { text, isError } = await drainToText(result)  // immediate=array; streaming=ReadableStream (reader loop)
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
```

`drainToText` concatenates content parts: `text/*` and `application/json` are
UTF-8 decoded; other mimes → `(mime, N bytes)`; a `tool-event::error` sets
`isError` and appends `error: <kind> · <message>`. Thrown errors are caught and
returned as `{ content:[{type:'text', text: msg}], isError: true }` (never
reject — an agent expects a tool result).

### Lifecycle / teardown

`exposeToWebmcp` creates one `AbortController`; every `registerTool` gets
`{ signal: controller.signal, exposedTo }`. `dispose()` aborts it (unregisters
all). Per-tool `registerTool` is wrapped in try/catch (a duplicate/invalid name
is `console.warn`-ed and that tool skipped, not thrown) so one bad tool can't
sink the batch; `count` reflects successful registrations. Registration is
awaited sequentially.

The playground holds `let webmcpExposure: WebmcpExposure | null`; on each load
it `dispose()`s the previous exposure before creating a new one.

### Playground wiring

- **`index.html`:** add `<div id="webmcp-status" class="webmcp-status muted">`
  under the Tools `<h2>` (line ~68).
- **`main.ts` startup gate** (beside the JSPI check): if
  `isWebmcpAvailable()` → `log('WebMCP available · document.modelContext', 'ok')`;
  else `log('WebMCP unavailable — native document.modelContext needs Chrome 149+ (chrome://flags/#enable-webmcp-testing) or the origin trial')`.
- **`main.ts` `loadFromBytes`**, after `loaded[]` is populated and any session
  opened:
  ```ts
  webmcpExposure?.dispose();
  webmcpExposure = exposeToWebmcp(
    toolProvider,
    resp.tools,
    { getSessionId: () => sessionId },
  );
  webmcpStatusEl.textContent = webmcpExposure.available
    ? `✓ ${webmcpExposure.count} tool(s) exposed to your browser agent on document.modelContext`
    : 'document.modelContext unavailable in this browser';
  ```
- No change to `chat.ts` or the local-LLM path.

## Verification

**`@actcore/host` (`node --test`, no browser needed):**
- `toDescriptor` mapping: name sanitization (incl. an out-of-range name),
  description resolution (plain + localized), `inputSchema` parse + fallback,
  `readOnlyHint` from metadata, `untrustedContentHint` default.
- `execute` bridge against a **fake `ToolProvider`**: immediate text result →
  `{content:[{type:'text'}]}`; error event → `isError:true`; thrown → caught;
  `getSessionId` → `std:session-id` present in the `callTool` metadata arg.
- `exposeToWebmcp` register/dispose against a **fake `globalThis.document.modelContext`**:
  registers N tools, `count`/`available` correct, `dispose()` fires the abort
  signal; unavailable path returns `{count:0, available:false}`.
- `npm run build` + `npm run typecheck` green.

**playground:**
- `npm run typecheck` + `npm run build` green (against the local
  `file:../host-browser` build).
- Browser smoke (Chrome 137+ for JSPI): inject a faithful ~15-line
  `document.modelContext` stub *before* load, load `time.wasm`, assert
  (a) `registerTool` received the expected descriptor and (b) the stored
  `execute()` round-trips to the real component and returns the actual time as
  MCP text content. Confirm the unavailable-path notice with no stub.

## Risks / open questions

- **Pre-standardization churn.** WebMCP is unshipped and moving (spec commits
  mid-2026, `getTools`/`executeTool` not yet in normative IDL). We depend only
  on `registerTool` + `AbortSignal` + the descriptor shape, which are the most
  stable parts. Ambient types are ours, so upstream renames won't break the build.
- **`cbor2` in `@actcore/host`.** Adds one small dep to the host (decision #5).
  Confirm before implementing.
- **`@actcore/host` release.** Shipping to prod beyond the playground's own
  Pages build (which rebuilds host from the sibling repo) needs an
  `@actcore/host` version bump + publish. Out of scope for the code change;
  noted for follow-up.

## References

- Spec (WebIDL): https://webmachinelearning.github.io/webmcp/
- Explainer: https://github.com/webmachinelearning/webmcp
- Chrome overview: https://developer.chrome.com/docs/ai/webmcp
- Chrome imperative API: https://developer.chrome.com/docs/ai/webmcp/imperative-api
- Chrome tool security / consent: https://developer.chrome.com/docs/ai/webmcp/secure-tools
