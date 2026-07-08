# WebMCP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a loaded ACT component's tools on the browser's native WebMCP surface (`document.modelContext`) so a WebMCP-capable browser agent can discover and call them.

**Architecture:** A headless, opt-in bridge lives in `@actcore/host` (`src/webmcp.ts`): it maps each `ToolDefinition` to a WebMCP tool descriptor, bridges `execute(input)` to `ToolProvider.callTool` (dcbor-encoding args, forwarding `std:session-id`, draining tool-events to text), and registers/unregisters tools via an `AbortController`. The playground calls `exposeToWebmcp` after loading a component and renders a status line. Native-only and feature-gated — no polyfill.

**Tech Stack:** TypeScript (ESM), `@bytecodealliance/jco`, `cbor2` (new host dep), Node `node --test` (host), Vite (playground), WebMCP `document.modelContext`.

## Global Constraints

- **Native-only, no polyfill.** The bridge uses `document.modelContext` (fallback alias `navigator.modelContext`) only; where absent it no-ops and the UI shows a notice. Do NOT add `@mcp-b/*` or any polyfill.
- **One new dependency:** `cbor2` added to `@actcore/host` (already used elsewhere in the ACT JS ecosystem). No other new deps.
- **WebMCP descriptor rules (verbatim):** `name` non-empty, ≤128 chars, ASCII `[A-Za-z0-9_.-]`; `execute(input)` returns MCP form `{ content: [{ type: 'text', text }], isError? }`; unregister via `AbortSignal`, never a method.
- **Annotations:** `readOnlyHint` from ACT `std:read-only` metadata (omit when absent); `untrustedContentHint: true` always.
- **Repos:** host code in `/mnt/devenv/workspace/act/host-browser` (published as `@actcore/host`); playground in `/mnt/devenv/workspace/act/playground` (consumes host via `file:../host-browser`).
- **Commits:** conventional-commit messages, committed with `bash ~/unwork.sh git commit -m "…"`. Never use `--no-verify`.
- **Host test cycle:** tests import from built `../dist/*.js`. Compile with `npx tsc` (fast; the WIT-derived `src/generated/` types are unchanged by this work), then run `node --test 'tests/*.test.mjs'`. Run the full `npm run build` once at the end of the host work to confirm the real pipeline.
- **Node ≥ 20** (host `engines`).

Every task's requirements implicitly include this section.

---

## File Structure

| File | Repo | Responsibility |
|------|------|----------------|
| `src/webmcp.ts` (create) | host-browser | The entire bridge: WebMCP ambient types, `getModelContext`/`isWebmcpAvailable`, pure mapping helpers, `drainToText`, `buildExecute`, `toDescriptor`, `exposeToWebmcp`. |
| `src/index.ts` (modify) | host-browser | Re-export the public API (`isWebmcpAvailable`, `exposeToWebmcp`, `ExposeWebmcpOptions`, `WebmcpExposure`). |
| `package.json` (modify) | host-browser | Add `cbor2` dependency. |
| `tests/webmcp.test.mjs` (create) | host-browser | Node unit tests for every bridge unit. |
| `index.html` (modify) | playground | `#webmcp-status` line under the Tools heading. |
| `src/main.ts` (modify) | playground | Startup gate log; `exposeToWebmcp` call + dispose/re-expose in `loadFromBytes`; status-line update. |
| `src/styles.css` (modify) | playground | Minimal `.webmcp-status` spacing rule. |

Everything the bridge does lives in one focused module (`src/webmcp.ts`) because the pieces (detect → map → execute → register) change together and are small.

---

## Task 1: WebMCP detection + module foundation

**Files:**
- Modify: `/mnt/devenv/workspace/act/host-browser/package.json` (add `cbor2`)
- Create: `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts`
- Modify: `/mnt/devenv/workspace/act/host-browser/src/index.ts`
- Test: `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ModelContext { registerTool(tool: WebmcpToolDescriptor, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void> }`
  - `interface WebmcpToolDescriptor { name: string; description: string; title?: string; inputSchema?: object; annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }; execute: (input: Record<string, unknown>) => Promise<WebmcpCallResult> }`
  - `interface WebmcpCallResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }`
  - `function getModelContext(): ModelContext | null`
  - `function isWebmcpAvailable(): boolean`
  - Global augmentation: `Document.modelContext?: ModelContext`, `Navigator.modelContext?: ModelContext`.

- [ ] **Step 1: Add the `cbor2` dependency**

In `/mnt/devenv/workspace/act/host-browser`:

```bash
cd /mnt/devenv/workspace/act/host-browser
npm install cbor2@^2.3.0
```

Expected: `package.json` `dependencies` now contains `"cbor2": "^2.3.0"`; `package-lock.json` updated.

- [ ] **Step 2: Write the failing test**

Create `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { isWebmcpAvailable } from '../dist/webmcp.js';

test('isWebmcpAvailable is false when no modelContext exists', () => {
  assert.equal(isWebmcpAvailable(), false);
});

test('isWebmcpAvailable is true when document.modelContext exists', () => {
  globalThis.document = { modelContext: { registerTool: async () => {} } };
  try {
    assert.equal(isWebmcpAvailable(), true);
  } finally {
    delete globalThis.document;
  }
});

test('isWebmcpAvailable falls back to navigator.modelContext', () => {
  const priorNav = globalThis.navigator;
  globalThis.navigator = { modelContext: { registerTool: async () => {} } };
  try {
    assert.equal(isWebmcpAvailable(), true);
  } finally {
    if (priorNav === undefined) delete globalThis.navigator;
    else globalThis.navigator = priorNav;
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: FAIL — `tsc` errors or `Cannot find module '../dist/webmcp.js'` (the module does not exist yet).

- [ ] **Step 4: Create `src/webmcp.ts` with types + detection**

Create `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts`:

```ts
/**
 * Bridge: expose an ACT component's tools on the browser's native WebMCP
 * surface (`document.modelContext`). Native-only, feature-gated, opt-in.
 *
 * WebMCP is pre-standardization; we type only the slice we depend on
 * (`registerTool` + `AbortSignal`) so upstream churn cannot break the build.
 * Spec: https://webmachinelearning.github.io/webmcp/
 */

/** MCP-style result an `execute` handler returns. */
export interface WebmcpCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** A single WebMCP tool descriptor passed to `registerTool`. */
export interface WebmcpToolDescriptor {
  name: string;
  description: string;
  title?: string;
  inputSchema?: object;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<WebmcpCallResult>;
}

interface RegisterToolOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

/** The slice of the native `document.modelContext` surface we use. */
export interface ModelContext {
  registerTool(tool: WebmcpToolDescriptor, options?: RegisterToolOptions): Promise<void>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}

/** Native WebMCP surface if present (canonical `document`, legacy `navigator`). */
export function getModelContext(): ModelContext | null {
  if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
  if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
  return null;
}

/** True when the browser exposes a native WebMCP surface. */
export function isWebmcpAvailable(): boolean {
  return getModelContext() !== null;
}
```

- [ ] **Step 5: Re-export from `src/index.ts`**

Append to `/mnt/devenv/workspace/act/host-browser/src/index.ts` (after the existing exports, e.g. after line 51):

```ts
export { isWebmcpAvailable } from './webmcp.js';
export type { ModelContext, WebmcpToolDescriptor, WebmcpCallResult } from './webmcp.js';
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
cd /mnt/devenv/workspace/act/host-browser
git add package.json package-lock.json src/webmcp.ts src/index.ts tests/webmcp.test.mjs
bash ~/unwork.sh git commit -m "feat(webmcp): add document.modelContext detection and cbor2 dep"
```

---

## Task 2: Pure descriptor mapping helpers

**Files:**
- Modify: `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts`
- Test: `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`

**Interfaces:**
- Consumes: `Metadata = Array<[string, Uint8Array]>` from `./generated/interfaces/act-core-types.js`.
- Produces:
  - `function sanitizeName(name: string): string`
  - `function parseInputSchema(schemaStr: string): object`
  - `function readReadOnlyHint(metadata: Metadata): boolean | undefined`
  - `function buildAnnotations(metadata: Metadata): { readOnlyHint?: boolean; untrustedContentHint: boolean }`

- [ ] **Step 1: Write the failing tests**

Append to `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`:

```js
import { encode } from 'cbor2';
import {
  sanitizeName,
  parseInputSchema,
  readReadOnlyHint,
  buildAnnotations,
} from '../dist/webmcp.js';

test('sanitizeName keeps valid chars, replaces others, truncates to 128', () => {
  assert.equal(sanitizeName('get_current_time'), 'get_current_time');
  assert.equal(sanitizeName('weird name/with:sep'), 'weird_name_with_sep');
  assert.equal(sanitizeName(''), 'tool');
  assert.equal(sanitizeName('a'.repeat(200)).length, 128);
});

test('parseInputSchema parses valid JSON Schema, falls back otherwise', () => {
  assert.deepEqual(parseInputSchema('{"type":"object","properties":{"x":{"type":"string"}}}'), {
    type: 'object',
    properties: { x: { type: 'string' } },
  });
  assert.deepEqual(parseInputSchema(''), { type: 'object', properties: {} });
  assert.deepEqual(parseInputSchema('not json'), { type: 'object', properties: {} });
});

test('readReadOnlyHint decodes std:read-only boolean from metadata', () => {
  const meta = [['std:read-only', encode(true, { dcbor: true })]];
  assert.equal(readReadOnlyHint(meta), true);
  assert.equal(readReadOnlyHint([['other', encode(1, { dcbor: true })]]), undefined);
  assert.equal(readReadOnlyHint([]), undefined);
});

test('buildAnnotations sets untrustedContentHint true, readOnlyHint from meta', () => {
  assert.deepEqual(buildAnnotations([['std:read-only', encode(true, { dcbor: true })]]), {
    readOnlyHint: true,
    untrustedContentHint: true,
  });
  assert.deepEqual(buildAnnotations([]), { untrustedContentHint: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: FAIL — `sanitizeName`/`parseInputSchema`/`readReadOnlyHint`/`buildAnnotations` are not exported.

- [ ] **Step 3: Implement the helpers**

Add to `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts` (top-level import + helpers):

```ts
import { decode } from 'cbor2';
import type { Metadata } from './generated/interfaces/act-core-types.js';

/** Coerce an ACT tool name to WebMCP's `[A-Za-z0-9_.-]`, ≤128, non-empty. */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return cleaned || 'tool';
}

/** ACT `parameters-schema` (a JSON Schema string) → a JSON Schema object. */
export function parseInputSchema(schemaStr: string): object {
  if (schemaStr && schemaStr.trim()) {
    try {
      const parsed = JSON.parse(schemaStr);
      if (parsed && typeof parsed === 'object') return parsed as object;
    } catch {
      /* fall through to default */
    }
  }
  return { type: 'object', properties: {} };
}

/** Read the `std:read-only` boolean from ACT tool metadata, if present. */
export function readReadOnlyHint(metadata: Metadata): boolean | undefined {
  for (const [key, val] of metadata) {
    if (key === 'std:read-only') {
      try {
        const decoded = decode(val);
        if (typeof decoded === 'boolean') return decoded;
      } catch {
        /* ignore undecodable value */
      }
    }
  }
  return undefined;
}

/** WebMCP annotations for an ACT tool: readOnly from meta, untrusted by default. */
export function buildAnnotations(
  metadata: Metadata,
): { readOnlyHint?: boolean; untrustedContentHint: boolean } {
  const readOnly = readReadOnlyHint(metadata);
  return {
    ...(readOnly !== undefined ? { readOnlyHint: readOnly } : {}),
    untrustedContentHint: true,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
cd /mnt/devenv/workspace/act/host-browser
git add src/webmcp.ts tests/webmcp.test.mjs
bash ~/unwork.sh git commit -m "feat(webmcp): map ACT tool definitions to WebMCP descriptors"
```

---

## Task 3: Result draining + execute bridge

**Files:**
- Modify: `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts`
- Test: `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`

**Interfaces:**
- Consumes:
  - `ToolProvider` from `./host-api.js` — `callTool(name: string, args: Uint8Array, metadata: Metadata): Promise<ToolResult>`.
  - `ToolDefinition` from `./generated/interfaces/act-tools-types.js` — `{ name: string; description: LocalizedString; parametersSchema: string; metadata: Metadata }`.
  - `ToolResult` (`{ tag: 'immediate'; val: ToolEvent[] } | { tag: 'streaming'; val: ReadableStream<ToolEvent> }`), `ToolEvent` (`{ tag: 'content'; val: ContentPart } | { tag: 'error'; val: { kind: string; message: LocalizedString } }`), `ContentPart` (`{ data: Uint8Array; mimeType?: string }`).
  - `resolveLocalizedString` from `./locale.js`.
  - `ExposeWebmcpOptions` (defined here, see Produces).
- Produces:
  - `interface ExposeWebmcpOptions { getSessionId?: () => string | null | undefined; exposedTo?: string[] }`
  - `function buildExecute(provider: ToolProvider, def: ToolDefinition, options: ExposeWebmcpOptions): (input: Record<string, unknown>) => Promise<WebmcpCallResult>`

- [ ] **Step 1: Write the failing tests**

Append to `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`:

```js
import { decode as decodeCbor } from 'cbor2';
import { buildExecute } from '../dist/webmcp.js';

const td = new TextDecoder();
const te = new TextEncoder();

function toolDef(name) {
  return { name, description: { tag: 'plain', val: `desc ${name}` }, parametersSchema: '{"type":"object"}', metadata: [] };
}

function immediateText(text) {
  return { tag: 'immediate', val: [{ tag: 'content', val: { data: te.encode(text), mimeType: 'text/plain', metadata: [] } }] };
}

test('buildExecute returns MCP text content for an immediate result', async () => {
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return immediateText('12:00'); } };
  const execute = buildExecute(provider, toolDef('t'), {});
  const result = await execute({});
  assert.deepEqual(result, { content: [{ type: 'text', text: '12:00' }] });
});

test('buildExecute marks isError for an error event', async () => {
  const errResult = { tag: 'immediate', val: [{ tag: 'error', val: { kind: 'boom', message: { tag: 'plain', val: 'bad' }, metadata: [] } }] };
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return errResult; } };
  const result = await buildExecute(provider, toolDef('t'), {})({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom · bad/);
});

test('buildExecute drains a streaming ReadableStream result', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue({ tag: 'content', val: { data: te.encode('chunk'), mimeType: 'text/plain', metadata: [] } });
      c.close();
    },
  });
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return { tag: 'streaming', val: stream }; } };
  const result = await buildExecute(provider, toolDef('t'), {})({});
  assert.equal(result.content[0].text, 'chunk');
});

test('buildExecute forwards std:session-id metadata and dcbor args', async () => {
  let captured;
  const provider = {
    async listTools() { return { metadata: [], tools: [] }; },
    async callTool(name, args, metadata) { captured = { name, args, metadata }; return immediateText('ok'); },
  };
  await buildExecute(provider, toolDef('do'), { getSessionId: () => 'sess-1' })({ a: 1 });
  assert.equal(captured.name, 'do');
  assert.deepEqual(decodeCbor(captured.args), { a: 1 });
  assert.equal(captured.metadata[0][0], 'std:session-id');
  assert.equal(decodeCbor(captured.metadata[0][1]), 'sess-1');
});

test('buildExecute catches a thrown provider error', async () => {
  const provider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { throw new Error('kaboom'); } };
  const result = await buildExecute(provider, toolDef('t'), {})({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /kaboom/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: FAIL — `buildExecute` is not exported.

- [ ] **Step 3: Implement `drainToText` + `buildExecute`**

Add to `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts`:

```ts
import { encode } from 'cbor2';
import type { ToolProvider } from './host-api.js';
import type { ToolDefinition, ToolEvent } from './generated/interfaces/act-tools-types.js';
import type { ToolResult } from './generated/interfaces/act-tools-tool-provider.js';
import { resolveLocalizedString } from './locale.js';

/** Options for {@link exposeToWebmcp}. */
export interface ExposeWebmcpOptions {
  /** Current session id, read per invocation; when set, forwarded as
   *  `std:session-id` metadata on every callTool. */
  getSessionId?: () => string | null | undefined;
  /** WebMCP `exposedTo` origin allowlist. Omit for default visibility. */
  exposedTo?: string[];
}

/** wasi:http content-parts surface mimeType as an `option<string>` variant
 *  (`{tag:'some',val}`) rather than a plain string; normalise both. */
function normalizeMime(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && (raw as { tag?: string }).tag === 'some') {
    return String((raw as { val: string }).val);
  }
  return 'application/octet-stream';
}

function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(Array.isArray(data) ? (data as number[]) : []);
}

/** Collect a ToolResult's events (immediate array or streaming ReadableStream)
 *  into a single text blob, flagging whether a terminal error occurred. */
async function drainToText(result: ToolResult): Promise<{ text: string; isError: boolean }> {
  const events: ToolEvent[] = [];
  if (result.tag === 'immediate') {
    events.push(...result.val);
  } else {
    const val = result.val as unknown as ReadableStream<ToolEvent> | ToolEvent[];
    if (Array.isArray(val)) {
      events.push(...val);
    } else {
      const reader = val.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) events.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
  }

  const parts: string[] = [];
  let isError = false;
  for (const ev of events) {
    if (ev.tag === 'content') {
      const mime = normalizeMime(ev.val.mimeType);
      const data = asBytes(ev.val.data);
      if (mime.startsWith('text/') || mime === 'application/json') {
        parts.push(new TextDecoder().decode(data));
      } else {
        parts.push(`(${mime}, ${data.length} bytes)`);
      }
    } else {
      isError = true;
      parts.push(`error: ${ev.val.kind} · ${resolveLocalizedString(ev.val.message)}`);
    }
  }
  return { text: parts.join('\n'), isError };
}

/** Build the WebMCP `execute` handler that bridges to `ToolProvider.callTool`. */
export function buildExecute(
  provider: ToolProvider,
  def: ToolDefinition,
  options: ExposeWebmcpOptions,
): (input: Record<string, unknown>) => Promise<WebmcpCallResult> {
  return async (input) => {
    try {
      const argBytes = encode(input ?? {}, { dcbor: true });
      const sessionId = options.getSessionId?.();
      const meta: Metadata = sessionId
        ? [['std:session-id', encode(sessionId, { dcbor: true })]]
        : [];
      const result = await provider.callTool(def.name, argBytes, meta);
      const { text, isError } = await drainToText(result);
      return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
cd /mnt/devenv/workspace/act/host-browser
git add src/webmcp.ts tests/webmcp.test.mjs
bash ~/unwork.sh git commit -m "feat(webmcp): bridge tool execution to callTool with session metadata"
```

---

## Task 4: `toDescriptor` + `exposeToWebmcp` public API

**Files:**
- Modify: `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts`
- Modify: `/mnt/devenv/workspace/act/host-browser/src/index.ts`
- Test: `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `function toDescriptor(provider: ToolProvider, def: ToolDefinition, options: ExposeWebmcpOptions): WebmcpToolDescriptor`
  - `interface WebmcpExposure { count: number; available: boolean; dispose(): void }`
  - `function exposeToWebmcp(provider: ToolProvider, tools: ToolDefinition[], options?: ExposeWebmcpOptions): Promise<WebmcpExposure>`

- [ ] **Step 1: Write the failing tests**

Append to `/mnt/devenv/workspace/act/host-browser/tests/webmcp.test.mjs`:

```js
import { toDescriptor, exposeToWebmcp } from '../dist/webmcp.js';

const fakeProvider = { async listTools() { return { metadata: [], tools: [] }; }, async callTool() { return immediateText('x'); } };

test('toDescriptor maps every field', () => {
  const def = { name: 'get time', description: { tag: 'plain', val: 'gets time' }, parametersSchema: '{"type":"object"}', metadata: [] };
  const d = toDescriptor(fakeProvider, def, {});
  assert.equal(d.name, 'get_time');
  assert.equal(d.description, 'gets time');
  assert.deepEqual(d.inputSchema, { type: 'object' });
  assert.deepEqual(d.annotations, { untrustedContentHint: true });
  assert.equal(typeof d.execute, 'function');
});

test('exposeToWebmcp registers all tools and reports count', async () => {
  const registered = [];
  globalThis.document = { modelContext: { async registerTool(t, o) { registered.push({ t, o }); } } };
  try {
    const exposure = await exposeToWebmcp(fakeProvider, [toolDef('a'), toolDef('b')]);
    assert.equal(exposure.available, true);
    assert.equal(exposure.count, 2);
    assert.equal(registered.length, 2);
    assert.equal(registered[0].t.name, 'a');
    assert.ok(registered[0].o.signal instanceof AbortSignal);
  } finally {
    delete globalThis.document;
  }
});

test('exposeToWebmcp dispose aborts the registration signal', async () => {
  let signal;
  globalThis.document = { modelContext: { async registerTool(_t, o) { signal = o.signal; } } };
  try {
    const exposure = await exposeToWebmcp(fakeProvider, [toolDef('a')]);
    assert.equal(signal.aborted, false);
    exposure.dispose();
    assert.equal(signal.aborted, true);
  } finally {
    delete globalThis.document;
  }
});

test('exposeToWebmcp reports unavailable when no modelContext', async () => {
  const exposure = await exposeToWebmcp(fakeProvider, [toolDef('a')]);
  assert.equal(exposure.available, false);
  assert.equal(exposure.count, 0);
});

test('exposeToWebmcp skips a failing registerTool but counts the rest', async () => {
  globalThis.document = { modelContext: { async registerTool(t) { if (t.name === 'bad') throw new Error('dup'); } } };
  try {
    const exposure = await exposeToWebmcp(fakeProvider, [toolDef('ok'), toolDef('bad'), toolDef('ok2')]);
    assert.equal(exposure.count, 2);
  } finally {
    delete globalThis.document;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: FAIL — `toDescriptor` / `exposeToWebmcp` not exported.

- [ ] **Step 3: Implement `toDescriptor` + `exposeToWebmcp`**

Add to `/mnt/devenv/workspace/act/host-browser/src/webmcp.ts`:

```ts
/** Map one ACT ToolDefinition to a WebMCP descriptor (execute included). */
export function toDescriptor(
  provider: ToolProvider,
  def: ToolDefinition,
  options: ExposeWebmcpOptions,
): WebmcpToolDescriptor {
  return {
    name: sanitizeName(def.name),
    description: resolveLocalizedString(def.description),
    inputSchema: parseInputSchema(def.parametersSchema),
    annotations: buildAnnotations(def.metadata),
    execute: buildExecute(provider, def, options),
  };
}

/** Handle returned by {@link exposeToWebmcp}. */
export interface WebmcpExposure {
  /** Number of tools successfully registered (0 when unavailable). */
  count: number;
  /** False when no native WebMCP surface was present. */
  available: boolean;
  /** Unregister all tools (aborts the registration signal). Idempotent. */
  dispose(): void;
}

/**
 * Register every tool of an ACT component on the native WebMCP surface.
 * Opt-in and headless — the caller decides when to call it and renders any UI.
 * No-ops (returns `available:false`) where `document.modelContext` is absent.
 * Call `dispose()` before re-exposing a different component.
 */
export async function exposeToWebmcp(
  provider: ToolProvider,
  tools: ToolDefinition[],
  options: ExposeWebmcpOptions = {},
): Promise<WebmcpExposure> {
  const mc = getModelContext();
  if (!mc) return { count: 0, available: false, dispose() {} };

  const controller = new AbortController();
  let count = 0;
  for (const def of tools) {
    const descriptor = toDescriptor(provider, def, options);
    try {
      await mc.registerTool(descriptor, {
        signal: controller.signal,
        ...(options.exposedTo ? { exposedTo: options.exposedTo } : {}),
      });
      count++;
    } catch (err) {
      console.warn(`[webmcp] registerTool("${descriptor.name}") failed:`, err);
    }
  }
  return { count, available: true, dispose: () => controller.abort() };
}
```

- [ ] **Step 4: Extend the public exports in `src/index.ts`**

Replace the WebMCP export lines added in Task 1 with:

```ts
export { isWebmcpAvailable, exposeToWebmcp } from './webmcp.js';
export type {
  ModelContext,
  WebmcpToolDescriptor,
  WebmcpCallResult,
  ExposeWebmcpOptions,
  WebmcpExposure,
} from './webmcp.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /mnt/devenv/workspace/act/host-browser
npx tsc && node --test tests/webmcp.test.mjs
```

Expected: PASS (all tests).

- [ ] **Step 6: Verify the full host build pipeline**

```bash
cd /mnt/devenv/workspace/act/host-browser
npm run build && npm test
```

Expected: `build` (gen-version + gen-types + tsc) succeeds; `npm test` runs the whole suite (version, transpile-cache, wasi-http, webmcp) green.

- [ ] **Step 7: Commit**

```bash
cd /mnt/devenv/workspace/act/host-browser
git add src/webmcp.ts src/index.ts tests/webmcp.test.mjs
bash ~/unwork.sh git commit -m "feat(webmcp): expose ACT tools on document.modelContext"
```

---

## Task 5: Playground wiring + status line

**Files:**
- Modify: `/mnt/devenv/workspace/act/playground/index.html` (~line 68)
- Modify: `/mnt/devenv/workspace/act/playground/src/main.ts`
- Modify: `/mnt/devenv/workspace/act/playground/src/styles.css`

**Interfaces:**
- Consumes from `@actcore/host`: `exposeToWebmcp(provider, tools, options?) => Promise<WebmcpExposure>`, `isWebmcpAvailable() => boolean`, type `WebmcpExposure`.

- [ ] **Step 1: Rebuild host so the playground sees the new API**

```bash
cd /mnt/devenv/workspace/act/host-browser && npm run build
cd /mnt/devenv/workspace/act/playground && npm run typecheck
```

Expected: host build green; playground `typecheck` currently PASSES (no WebMCP usage yet). If `typecheck` cannot resolve `@actcore/host` at all, run `npm install` in the playground first (re-links the `file:../host-browser` dependency), then re-run.

- [ ] **Step 2: Add the status element to `index.html`**

In `/mnt/devenv/workspace/act/playground/index.html`, change the Tools section (around line 67-70) from:

```html
    <section id="tools" class="tools" hidden>
      <h2>Tools</h2>
      <ul id="tool-list"></ul>
    </section>
```

to:

```html
    <section id="tools" class="tools" hidden>
      <h2>Tools</h2>
      <div id="webmcp-status" class="webmcp-status muted"></div>
      <ul id="tool-list"></ul>
    </section>
```

- [ ] **Step 3: Add a minimal style rule to `styles.css`**

Append to `/mnt/devenv/workspace/act/playground/src/styles.css`:

```css
.webmcp-status {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
}
```

- [ ] **Step 4: Import the WebMCP API and add element/state refs in `main.ts`**

In `/mnt/devenv/workspace/act/playground/src/main.ts`, update the `@actcore/host` import (line 30) from:

```ts
import { runComponent, resolveLocalizedString } from '@actcore/host';
```

to:

```ts
import {
  runComponent,
  resolveLocalizedString,
  exposeToWebmcp,
  isWebmcpAvailable,
  type WebmcpExposure,
} from '@actcore/host';
```

Then, next to the other element refs (after line 60, `const cardToolCountEl = ...`), add:

```ts
const webmcpStatusEl = document.getElementById('webmcp-status') as HTMLElement;
```

And next to the module state (after line 79, `let sessionId: string | null = null;`), add:

```ts
let webmcpExposure: WebmcpExposure | null = null;
```

- [ ] **Step 5: Register tools in `loadFromBytes`**

In `/mnt/devenv/workspace/act/playground/src/main.ts`, at the end of `loadFromBytes` (immediately after `cardToolCountEl.textContent = String(resp.tools.length);` and `renderToolList();`, around line 119-120), add:

```ts
  webmcpExposure?.dispose();
  webmcpExposure = await exposeToWebmcp(toolProvider, resp.tools, {
    getSessionId: () => sessionId,
  });
  if (webmcpExposure.available) {
    const n = webmcpExposure.count;
    webmcpStatusEl.textContent = `✓ ${n} tool${n === 1 ? '' : 's'} exposed to your browser agent on document.modelContext`;
    log(`WebMCP: ${n} tool${n === 1 ? '' : 's'} registered on document.modelContext`, 'ok');
  } else {
    webmcpStatusEl.textContent =
      'document.modelContext not available in this browser — WebMCP exposure skipped';
  }
```

- [ ] **Step 6: Add the startup gate log next to the JSPI gate**

In `/mnt/devenv/workspace/act/playground/src/main.ts`, after the JSPI gate block (after line 527, the closing `}` of the `else` branch that logs "JSPI available · ready"), add:

```ts
// === WebMCP gate ===========================================================
if (isWebmcpAvailable()) {
  log('WebMCP available · document.modelContext', 'ok');
} else {
  log(
    'WebMCP unavailable — native document.modelContext needs Chrome 149+ ' +
      '(chrome://flags/#enable-webmcp-testing) or the origin trial. Tools still ' +
      'load and run; they just are not exposed to a browser agent.',
  );
}
```

- [ ] **Step 7: Typecheck and build the playground**

```bash
cd /mnt/devenv/workspace/act/playground
npm run typecheck && npm run build
```

Expected: both green.

- [ ] **Step 8: Browser smoke test (real round-trip through a stubbed WebMCP surface)**

The native API ships nowhere by default here, so inject a faithful stub and verify the wiring end-to-end.

Start the dev server:

```bash
cd /mnt/devenv/workspace/act/playground
npm run dev
```

Then, using the claude-in-chrome browser tools (Chrome 137+ for JSPI):

1. Open a new tab and navigate to `http://localhost:5173`.
2. Before loading any component, install a capturing stub via `javascript_tool`:

```js
(() => {
  window.__wm = [];
  document.modelContext = {
    async registerTool(tool, options) {
      window.__wm.push({ tool, options });
    },
  };
  return 'stub installed';
})();
```

3. Load a component: set the URL input to the `time.wasm` example (click the time example chip, or type its URL) and click **Load**. Wait for the Tools list + the `#webmcp-status` line to render.
4. Assert the registration and a real round-trip via `javascript_tool`:

```js
(async () => {
  const names = window.__wm.map((r) => r.tool.name);
  const toolCount = document.querySelectorAll('#tool-list > li').length;
  const first = window.__wm[0].tool;
  const result = await first.execute({}); // round-trips to the real wasm component
  return {
    registeredCount: window.__wm.length,
    toolCount,
    names,
    hasSignal: window.__wm[0].options?.signal instanceof AbortSignal,
    executeResult: result,
    statusLine: document.getElementById('webmcp-status').textContent,
  };
})();
```

Expected: `registeredCount === toolCount` (every listed tool registered), `hasSignal === true`, `executeResult` is `{ content: [{ type: 'text', text: <a real time string> }] }`, and `statusLine` reads `✓ N tools exposed to your browser agent on document.modelContext`.

5. Reload the page WITHOUT the stub, confirm the Log shows the "WebMCP unavailable — native document.modelContext needs Chrome 149+…" line and that loading a component sets the status line to "document.modelContext not available in this browser — WebMCP exposure skipped".

Stop the dev server when done.

- [ ] **Step 9: Commit**

```bash
cd /mnt/devenv/workspace/act/playground
git add index.html src/main.ts src/styles.css
bash ~/unwork.sh git commit -m "feat(webmcp): register loaded component tools on document.modelContext"
```

---

## Self-Review

**Spec coverage:**
- Outward exposure of loaded tools → Tasks 4 (`exposeToWebmcp`) + 5 (wiring). ✓
- Native-only, feature-gated (`document.modelContext`, `navigator` fallback) → Task 1 + Task 5 gate. ✓
- Status-line-only UI → Task 5 (`#webmcp-status`, startup gate log). ✓
- Split: headless bridge in `@actcore/host`, UI in playground → Tasks 1-4 (host) vs Task 5 (playground). ✓
- `cbor2` owned by host → Task 1 dep + Tasks 2/3 usage. ✓
- Mapping (name/description/inputSchema/annotations) → Task 2 + Task 4 `toDescriptor`. ✓
- `execute` → `callTool`, dcbor args, `std:session-id`, drain events, MCP result → Task 3. ✓
- Streaming read via reader loop (not array assumption) → Task 3 `drainToText`. ✓
- Teardown via `AbortSignal`, per-tool skip, accurate count → Task 4. ✓
- `readOnlyHint` from `std:read-only` + `untrustedContentHint:true` → Task 2 `buildAnnotations`. ✓
- Verification: host `node --test` + build; playground typecheck/build + browser smoke → Task 4 Step 6, Task 5 Steps 7-8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands.

**Type consistency:** `exposeToWebmcp` is `Promise<WebmcpExposure>` in Tasks 4 and 5. `getSessionId`/`exposedTo` on `ExposeWebmcpOptions` match between Tasks 3 and 4. `WebmcpToolDescriptor`/`WebmcpCallResult`/`ModelContext` defined in Task 1, used unchanged in Tasks 3-4. `buildExecute`/`toDescriptor`/`sanitizeName`/`parseInputSchema`/`buildAnnotations` names are identical across definition and use.

**Notes for the executor:**
- `main.ts` line numbers are from the current file; if they have drifted, anchor on the quoted surrounding code instead.
- The playground `file:../host-browser` dependency serves the host's `dist/` — always rebuild host (`npm run build`) before re-checking the playground.
